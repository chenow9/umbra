package visit

import (
	"context"
	"encoding/hex"
	"fmt"
	"net"
	"sync"
	"time"

	"umbra/internal/netutil"
	"umbra/internal/uplane"
)

func serveUDPPlane(ctx context.Context, cfg Config, tlsConn net.Conn, visitID, cookieHex, mappingID string, pc *net.UDPConn) error {
	cookie, err := hex.DecodeString(cookieHex)
	if err != nil || len(cookie) != 16 {
		if err == nil {
			err = fmt.Errorf("bad udp cookie")
		}
		return err
	}
	ekm := uplane.ExportEKM(tlsConn)
	if len(ekm) != 32 {
		return fmt.Errorf("udp requires tls exported key")
	}
	c2s, s2c := uplane.DerivePair(ekm, cookie)
	out, in := &uplane.Writer{Key: c2s}, &uplane.Opener{Key: s2c}
	uaddr, err := net.ResolveUDPAddr("udp", cfg.Server)
	if err != nil {
		return err
	}
	uc, err := net.DialUDP("udp", nil, uaddr)
	if err != nil {
		return err
	}
	defer uc.Close()
	if err := netutil.SetUDPReadBuffer(uc); err != nil {
		return err
	}
	if err := waitBindAck(ctx, uc, out, in, visitID, cookie); err != nil {
		return err
	}
	_, _ = out.Write(visitID, uplane.Packet{Type: uplane.TypeBindConfirm, Payload: cookie}, uc.Write)

	if pc == nil {
		return fmt.Errorf("no local udp listener")
	}
	if err := netutil.SetUDPReadBuffer(pc); err != nil {
		return err
	}
	go func() {
		<-ctx.Done()
		_ = uc.Close()
		_ = pc.SetReadDeadline(time.Now())
	}()

	var mu sync.Mutex
	flows := map[string]string{}
	rev := map[string]*net.UDPAddr{}

	go func() {
		buf := uplane.GetBuf()
		defer uplane.PutBuf(buf)
		for {
			n, err := uc.Read(buf)
			if err != nil {
				_ = uc.Close()
				return
			}
			_, pkt, err := in.Decode(buf[:n])
			if err != nil || pkt.Type != uplane.TypeData {
				continue
			}
			mu.Lock()
			dest := rev[pkt.FlowID]
			mu.Unlock()
			if dest == nil && pkt.PeerIP != nil {
				dest = &net.UDPAddr{IP: pkt.PeerIP, Port: pkt.PeerPort}
			}
			if dest == nil {
				continue
			}
			_, _ = pc.WriteToUDP(pkt.Payload, dest)
		}
	}()
	buf := uplane.GetBuf()
	defer uplane.PutBuf(buf)
	for {
		_ = pc.SetReadDeadline(time.Now().Add(time.Second))
		n, raddr, err := pc.ReadFromUDP(buf)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				if ctx.Err() != nil {
					return ctx.Err()
				}
				continue
			}
			return err
		}
		pkey := raddr.String()
		mu.Lock()
		fid := flows[pkey]
		if fid == "" {
			fid = uplane.NewFlowID()
			flows[pkey] = fid
			rev[fid] = cloneUDPAddr(raddr)
		}
		mu.Unlock()
		_, err = out.Write(visitID, uplane.Packet{
			Type: uplane.TypeData, MappingID: mappingID, FlowID: fid,
			PeerIP: raddr.IP, PeerPort: raddr.Port, Payload: append([]byte(nil), buf[:n]...),
		}, uc.Write)
		if err != nil {
			continue
		}
	}
}

func waitBindAck(ctx context.Context, uc *net.UDPConn, out *uplane.Writer, in *uplane.Opener, id string, cookie []byte) error {
	buf := uplane.GetBuf()
	defer uplane.PutBuf(buf)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if _, err := out.Write(id, uplane.Packet{Type: uplane.TypeBind, Payload: cookie}, uc.Write); err != nil {
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
	return fmt.Errorf("udp bind timeout")
}
