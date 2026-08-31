package node

import (
	"encoding/hex"
	"errors"
	"net"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"umbra/internal/netutil"
	"umbra/internal/policy"
	"umbra/internal/uplane"
)

const defaultUDPConfirmEvery = 5 * time.Second

// udpConfirmEveryNS is the BindConfirm interval in nanoseconds.
// Zero means defaultUDPConfirmEvery. Tests may store a shorter value.
var udpConfirmEveryNS atomic.Int64

// SetUDPConfirmEvery sets how often the node refreshes uplane readiness.
// Independent of tunnel Read timeouts so one-way UDP still keeps the path alive.
// A non-positive duration restores the default.
func SetUDPConfirmEvery(d time.Duration) {
	if d <= 0 {
		udpConfirmEveryNS.Store(0)
		return
	}
	udpConfirmEveryNS.Store(int64(d))
}

func udpConfirmEvery() time.Duration {
	d := time.Duration(udpConfirmEveryNS.Load())
	if d <= 0 {
		return defaultUDPConfirmEvery
	}
	return d
}

type udpLocal struct {
	c       *net.UDPConn
	idle    time.Duration
	last    atomic.Int64
	closing atomic.Bool
}

func (rt *session) runUDP(cookieHex, mode string) {
	stats := &udpStats{}
	stopStats := stats.startReporter(rt.ctx, rt.id, udpStatsInterval())
	defer stopStats()
	cookie, err := hex.DecodeString(cookieHex)
	if err != nil || len(cookie) != 16 {
		return
	}
	ekm := uplane.ExportEKM(rt.raw)
	if len(ekm) != 32 {
		return
	}
	c2s, s2c := uplane.DerivePair(ekm, cookie)
	out, in := &uplane.Writer{Key: c2s}, &uplane.Opener{Key: s2c}
	uaddr, err := net.ResolveUDPAddr("udp", rt.server)
	if err != nil {
		return
	}
	uc, err := net.DialUDP("udp", nil, uaddr)
	if err != nil {
		return
	}
	if err := netutil.SetUDPReadBuffer(uc); err != nil {
		_ = uc.Close()
		return
	}
	defer uc.Close()
	go func() {
		<-rt.ctx.Done()
		_ = uc.Close()
	}()
	if err := waitBindAck(uc, out, in, rt.id, cookie); err != nil {
		if mode == "required" || mode == "uplane-required" || mode == "uplane" {
			_ = rt.raw.Close()
		}
		return
	}
	_ = sendConfirm(uc, out, rt.id, cookie)
	tick := time.NewTicker(udpConfirmEvery())
	defer tick.Stop()
	stopConfirm := make(chan struct{})
	defer close(stopConfirm)
	go func() {
		for {
			select {
			case <-rt.ctx.Done():
				return
			case <-stopConfirm:
				return
			case <-tick.C:
				_ = sendConfirm(uc, out, rt.id, cookie)
			}
		}
	}()

	locals := map[string]*udpLocal{}
	var mu sync.Mutex
	var localWG sync.WaitGroup
	defer func() {
		mu.Lock()
		for _, loc := range locals {
			loc.closing.Store(true)
			_ = loc.c.Close()
		}
		mu.Unlock()
		localWG.Wait()
	}()
	buf := uplane.GetBuf()
	defer uplane.PutBuf(buf)
	for {
		if rt.ctx.Err() != nil {
			return
		}
		_ = uc.SetReadDeadline(time.Now().Add(30 * time.Second))
		n, err := uc.Read(buf)
		if err != nil {
			if rt.ctx.Err() != nil {
				return
			}
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				continue
			}
			stats.uplaneReadErrors.Add(1)
			return
		}
		stats.uplaneRxPackets.Add(1)
		stats.uplaneRxBytes.Add(int64(n))
		_, pkt, err := in.Decode(buf[:n])
		if err != nil {
			stats.uplaneDecodeErrors.Add(1)
			continue
		}
		if pkt.Type == uplane.TypeBindAck {
			continue
		}
		if pkt.Type == uplane.TypeClose {
			if pkt.MappingID != "" && pkt.FlowID != "" {
				closeUDPLocal(&mu, locals, pkt.MappingID+"|"+pkt.FlowID)
			}
			continue
		}
		if pkt.Type != uplane.TypeData {
			continue
		}
		rt.haveMu.Lock()
		m, ok := rt.have[pkt.MappingID]
		rt.haveMu.Unlock()
		if !ok || !m.Enabled || m.Proto != "udp" {
			stats.unknownMappingDrops.Add(1)
			continue
		}
		if pkt.FlowID == "" {
			stats.emptyFlowIDDrops.Add(1)
			continue
		}
		lkey := pkt.MappingID + "|" + pkt.FlowID
		mu.Lock()
		loc := locals[lkey]
		if loc == nil {
			raddr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(m.LocalHost, strconv.Itoa(m.LocalPort)))
			if err != nil {
				stats.targetResolveErrors.Add(1)
				mu.Unlock()
				continue
			}
			c, err := net.DialUDP("udp", nil, raddr)
			if err != nil {
				stats.targetDialErrors.Add(1)
				mu.Unlock()
				continue
			}
			if err := netutil.SetUDPReadBuffer(c); err != nil {
				_ = c.Close()
				stats.targetDialErrors.Add(1)
				mu.Unlock()
				continue
			}
			idle := policy.UDPIdle(m.UdpIdleTimeoutSec, m.IdleTimeoutSec)
			loc = &udpLocal{c: c, idle: idle}
			loc.last.Store(time.Now().UnixNano())
			locals[lkey] = loc
			stats.activeUDPFlows.Add(1)
			localWG.Add(1)
			go func(pkt uplane.Packet, loc *udpLocal, lkey string) {
				defer localWG.Done()
				rt.readLocalUDP(uc, out, pkt, loc, lkey, &mu, locals, stats)
			}(pkt, loc, lkey)
		}
		loc.last.Store(time.Now().UnixNano())
		c := loc.c
		mu.Unlock()
		if n, err := c.Write(pkt.Payload); err != nil || n != len(pkt.Payload) {
			stats.targetWriteErrors.Add(1)
		} else {
			stats.targetWritePackets.Add(1)
			stats.targetWriteBytes.Add(int64(n))
		}
	}
}

func sendBind(uc *net.UDPConn, out *uplane.Writer, id string, cookie []byte) error {
	_, err := out.Write(id, uplane.Packet{Type: uplane.TypeBind, Payload: cookie}, uc.Write)
	return err
}

func sendConfirm(uc *net.UDPConn, out *uplane.Writer, id string, cookie []byte) error {
	_, err := out.Write(id, uplane.Packet{Type: uplane.TypeBindConfirm, Payload: cookie}, uc.Write)
	return err
}

func waitBindAck(uc *net.UDPConn, out *uplane.Writer, in *uplane.Opener, id string, cookie []byte) error {
	buf := uplane.GetBuf()
	defer uplane.PutBuf(buf)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if err := sendBind(uc, out, id, cookie); err != nil {
			return err
		}
		_ = uc.SetReadDeadline(time.Now().Add(400 * time.Millisecond))
		n, err := uc.Read(buf)
		if err != nil {
			continue
		}
		_, pkt, err := in.Decode(buf[:n])
		if err != nil {
			continue
		}
		if pkt.Type == uplane.TypeBindAck {
			_ = uc.SetReadDeadline(time.Time{})
			return nil
		}
	}
	return errBindTimeout
}

var errBindTimeout = errString("udp bind timeout")

type errString string

func (e errString) Error() string { return string(e) }

func closeUDPLocal(mu *sync.Mutex, locals map[string]*udpLocal, key string) {
	mu.Lock()
	loc := locals[key]
	if loc != nil {
		delete(locals, key)
	}
	mu.Unlock()
	if loc != nil {
		loc.closing.Store(true)
		_ = loc.c.Close()
	}
}

func (rt *session) readLocalUDP(uc *net.UDPConn, out *uplane.Writer, tmpl uplane.Packet, loc *udpLocal, lkey string, mu *sync.Mutex, locals map[string]*udpLocal, stats *udpStats) {
	defer func() {
		mu.Lock()
		if locals[lkey] == loc {
			delete(locals, lkey)
		}
		mu.Unlock()
		_ = loc.c.Close()
		stats.activeUDPFlows.Add(-1)
	}()
	buf := uplane.GetBuf()
	defer uplane.PutBuf(buf)
	for {
		if rt.ctx.Err() != nil {
			return
		}
		_ = loc.c.SetReadDeadline(time.Now().Add(time.Second))
		n, err := loc.c.Read(buf)
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				last := time.Unix(0, loc.last.Load())
				if time.Since(last) < loc.idle {
					continue
				}
				stats.expiredUDPFlows.Add(1)
			} else if rt.ctx.Err() == nil && !loc.closing.Load() {
				stats.targetReadErrors.Add(1)
			}
			return
		}
		stats.targetRxPackets.Add(1)
		stats.targetRxBytes.Add(int64(n))
		loc.last.Store(time.Now().UnixNano())
		n, err = out.Write(rt.id, uplane.Packet{
			Type: uplane.TypeData, MappingID: tmpl.MappingID, FlowID: tmpl.FlowID,
			PeerIP: tmpl.PeerIP, PeerPort: tmpl.PeerPort, Payload: buf[:n],
		}, uc.Write)
		if err != nil {
			if errors.Is(err, uplane.ErrWriterEncode) {
				stats.uplaneEncodeErrors.Add(1)
			} else {
				stats.uplaneWriteErrors.Add(1)
			}
			return
		}
		stats.uplaneTxPackets.Add(1)
		stats.uplaneTxBytes.Add(int64(n))
	}
}
