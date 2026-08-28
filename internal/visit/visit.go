package visit

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/hashicorp/yamux"

	"umbra/internal/muxcfg"
	"umbra/internal/preface"
	"umbra/internal/wire"
	"umbra/internal/xfer"
)

type Config struct {
	Server   string
	Ticket   string
	Local    string
	TLS      *tls.Config
	OnListen func(network, addr string)
}

func Run(ctx context.Context, cfg Config) error {
	d := net.Dialer{Timeout: 8 * time.Second}
	raw, err := d.Dial("tcp", cfg.Server)
	if err != nil {
		return err
	}
	_ = raw.SetDeadline(time.Now().Add(8 * time.Second))
	if cfg.TLS != nil {
		tc := tls.Client(raw, cfg.TLS)
		if err := tc.Handshake(); err != nil {
			_ = raw.Close()
			return err
		}
		raw = tc
	}
	if err := preface.Write(raw, preface.KindVisit, cfg.Ticket); err != nil {
		_ = raw.Close()
		return err
	}
	_ = raw.SetDeadline(time.Time{})
	defer raw.Close()

	sess, err := yamux.Client(raw, muxcfg.Config())
	if err != nil {
		return err
	}
	defer sess.Close()

	ctrl, err := sess.OpenStream()
	if err != nil {
		return err
	}
	wc := wire.NewConn(ctrl)
	if err := wc.SendJSON("Visit", map[string]string{"ticket": cfg.Ticket}); err != nil {
		return err
	}
	env, err := wc.Read()
	if err != nil {
		return err
	}
	if env.Type == "Dropped" {
		reason, _ := wire.Decode[struct {
			Reason string `json:"reason"`
		}](env.Body)
		return fmt.Errorf("visit rejected: %s", reason.Reason)
	}
	if env.Type != "VisitOk" {
		return fmt.Errorf("unexpected %s", env.Type)
	}
	ok, err := wire.Decode[struct {
		MappingID string `json:"mapping_id"`
		Proto     string `json:"proto"`
		VisitID   string `json:"visit_id"`
		UDPCookie string `json:"udp_cookie"`
		UDPMode   string `json:"udp_mode"`
	}](env.Body)
	if err != nil {
		return err
	}
	if ok.Proto == "udp" {
		required := ok.UDPMode == "required" || ok.UDPMode == "uplane-required" || ok.UDPMode == "uplane"
		if required && (ok.VisitID == "" || ok.UDPCookie == "") {
			return fmt.Errorf("uplane required but missing cookie")
		}
		if ok.VisitID != "" && ok.UDPCookie != "" {
			err := serveUDPPlane(ctx, cfg, raw, ok.VisitID, ok.UDPCookie, ok.MappingID)
			if err == nil {
				return nil
			}
			if required {
				return err
			}
			return serveUDP(ctx, sess, cfg, ok.MappingID)
		}
		return serveUDP(ctx, sess, cfg, ok.MappingID)
	}
	return serveTCP(ctx, sess, cfg, ok.MappingID)
}

func serveTCP(ctx context.Context, sess *yamux.Session, cfg Config, mappingID string) error {
	ln, err := net.Listen("tcp", cfg.Local)
	if err != nil {
		return err
	}
	defer ln.Close()
	if cfg.OnListen != nil {
		cfg.OnListen("tcp", ln.Addr().String())
	}
	go func() {
		<-ctx.Done()
		_ = ln.Close()
		_ = sess.Close()
	}()
	for {
		c, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		go func(c net.Conn) {
			defer c.Close()
			st, err := sess.OpenStream()
			if err != nil {
				return
			}
			ip, port := peerOf(c.RemoteAddr())
			if err := wire.WriteOpen(st, wire.StreamOpen{
				MappingID: mappingID, Proto: "tcp", PeerIP: ip, PeerPort: port, Via: "visitor",
			}); err != nil {
				_ = st.Close()
				return
			}
			xfer.CopyBidirectional(st, c, nil, nil)
		}(c)
	}
}

func serveUDP(ctx context.Context, sess *yamux.Session, cfg Config, mappingID string) error {
	addr, err := net.ResolveUDPAddr("udp", cfg.Local)
	if err != nil {
		return err
	}
	pc, err := net.ListenUDP("udp", addr)
	if err != nil {
		return err
	}
	defer pc.Close()
	if cfg.OnListen != nil {
		cfg.OnListen("udp", pc.LocalAddr().String())
	}
	go func() {
		<-ctx.Done()
		_ = pc.Close()
		_ = sess.Close()
	}()

	type sessRow struct {
		st    net.Conn
		timer *time.Timer
	}
	var mu sync.Mutex
	rows := map[string]*sessRow{}
	buf := make([]byte, 64*1024)
	for {
		n, raddr, err := pc.ReadFromUDP(buf)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		key := raddr.String()
		mu.Lock()
		row := rows[key]
		if row == nil {
			st, err := sess.OpenStream()
			if err != nil {
				mu.Unlock()
				continue
			}
			if err := wire.WriteOpen(st, wire.StreamOpen{
				MappingID: mappingID, Proto: "udp", PeerIP: raddr.IP.String(), PeerPort: raddr.Port, Via: "visitor",
			}); err != nil {
				_ = st.Close()
				mu.Unlock()
				continue
			}
			row = &sessRow{st: st}
			rows[key] = row
			go func(st net.Conn, raddr *net.UDPAddr, key string) {
				for {
					p, err := wire.ReadDatagram(st)
					if err != nil {
						mu.Lock()
						if rows[key] != nil && rows[key].st == st {
							delete(rows, key)
						}
						mu.Unlock()
						_ = st.Close()
						return
					}
					_, _ = pc.WriteToUDP(p, raddr)
				}
			}(st, cloneUDPAddr(raddr), key)
		}
		if row.timer != nil {
			row.timer.Stop()
		}
		st := row.st
		row.timer = time.AfterFunc(60*time.Second, func() {
			mu.Lock()
			if rows[key] != nil && rows[key].st == st {
				delete(rows, key)
			}
			mu.Unlock()
			_ = st.Close()
		})
		mu.Unlock()
		_ = wire.WriteDatagram(st, buf[:n])
	}
}

func cloneUDPAddr(a *net.UDPAddr) *net.UDPAddr {
	ip := make(net.IP, len(a.IP))
	copy(ip, a.IP)
	return &net.UDPAddr{IP: ip, Port: a.Port, Zone: a.Zone}
}

func peerOf(a net.Addr) (string, int) {
	if ta, ok := a.(*net.TCPAddr); ok {
		return ta.IP.String(), ta.Port
	}
	host, port, _ := net.SplitHostPort(a.String())
	p := 0
	fmt.Sscanf(port, "%d", &p)
	return host, p
}
