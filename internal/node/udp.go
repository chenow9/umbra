package node

import (
	"encoding/hex"
	"net"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

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
	c    *net.UDPConn
	idle time.Duration
	last atomic.Int64
}

func (rt *session) runUDP(cookieHex, mode string) {
	cookie, err := hex.DecodeString(cookieHex)
	if err != nil || len(cookie) != 16 {
		return
	}
	ekm := uplane.ExportEKM(rt.raw)
	if len(ekm) != 32 {
		return
	}
	c2s, s2c := uplane.DerivePair(ekm, cookie)
	out, in := &uplane.Sealer{Key: c2s}, &uplane.Opener{Key: s2c}
	uaddr, err := net.ResolveUDPAddr("udp", rt.server)
	if err != nil {
		return
	}
	uc, err := net.DialUDP("udp", nil, uaddr)
	if err != nil {
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
	defer func() {
		mu.Lock()
		for _, loc := range locals {
			_ = loc.c.Close()
		}
		mu.Unlock()
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
			return
		}
		_, pkt, err := in.Decode(buf[:n])
		if err != nil {
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
			continue
		}
		if pkt.FlowID == "" {
			continue
		}
		lkey := pkt.MappingID + "|" + pkt.FlowID
		mu.Lock()
		loc := locals[lkey]
		if loc == nil {
			raddr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(m.LocalHost, strconv.Itoa(m.LocalPort)))
			if err != nil {
				mu.Unlock()
				continue
			}
			c, err := net.DialUDP("udp", nil, raddr)
			if err != nil {
				mu.Unlock()
				continue
			}
			idle := policy.UDPIdle(m.UdpIdleTimeoutSec, m.IdleTimeoutSec)
			loc = &udpLocal{c: c, idle: idle}
			loc.last.Store(time.Now().UnixNano())
			locals[lkey] = loc
			go rt.readLocalUDP(uc, out, pkt, loc, lkey, &mu, locals)
		}
		loc.last.Store(time.Now().UnixNano())
		c := loc.c
		mu.Unlock()
		_, _ = c.Write(pkt.Payload)
	}
}

func sendBind(uc *net.UDPConn, out *uplane.Sealer, id string, cookie []byte) error {
	raw, err := out.Encode(id, uplane.Packet{Type: uplane.TypeBind, Payload: cookie})
	if err != nil {
		return err
	}
	_, err = uc.Write(raw)
	return err
}

func sendConfirm(uc *net.UDPConn, out *uplane.Sealer, id string, cookie []byte) error {
	raw, err := out.Encode(id, uplane.Packet{Type: uplane.TypeBindConfirm, Payload: cookie})
	if err != nil {
		return err
	}
	_, err = uc.Write(raw)
	return err
}

func waitBindAck(uc *net.UDPConn, out *uplane.Sealer, in *uplane.Opener, id string, cookie []byte) error {
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
		_ = loc.c.Close()
	}
}

func (rt *session) readLocalUDP(uc *net.UDPConn, out *uplane.Sealer, tmpl uplane.Packet, loc *udpLocal, lkey string, mu *sync.Mutex, locals map[string]*udpLocal) {
	defer func() {
		mu.Lock()
		if locals[lkey] == loc {
			delete(locals, lkey)
		}
		mu.Unlock()
		_ = loc.c.Close()
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
			}
			return
		}
		loc.last.Store(time.Now().UnixNano())
		raw, err := out.Encode(rt.id, uplane.Packet{
			Type: uplane.TypeData, MappingID: tmpl.MappingID, FlowID: tmpl.FlowID,
			PeerIP: tmpl.PeerIP, PeerPort: tmpl.PeerPort, Payload: buf[:n],
		})
		if err != nil {
			return
		}
		if _, err := uc.Write(raw); err != nil {
			return
		}
	}
}
