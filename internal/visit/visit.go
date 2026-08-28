package visit

import (
	"context"
	"crypto/tls"
	"fmt"
	"log"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/hashicorp/yamux"

	"umbra/internal/muxcfg"
	"umbra/internal/preface"
	"umbra/internal/retry"
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

type localBind struct {
	proto string
	ln    net.Listener
	pc    *net.UDPConn
}

func (b *localBind) close() {
	if b == nil {
		return
	}
	if b.ln != nil {
		_ = b.ln.Close()
		b.ln = nil
	}
	if b.pc != nil {
		_ = b.pc.Close()
		b.pc = nil
	}
}

func Run(ctx context.Context, cfg Config) error {
	bind := &localBind{}
	defer bind.close()
	backoff := retry.Initial
	for {
		if ctx.Err() != nil {
			return nil
		}
		served := false
		err := dialAndServe(ctx, cfg, bind, &served)
		if ctx.Err() != nil {
			return nil
		}
		if err != nil && !retryableVisit(err) {
			return err
		}
		if served {
			backoff = retry.Initial
		}
		if err != nil {
			log.Printf("visit: %v — retry in ~%s", err, backoff)
		}
		if !retry.Sleep(ctx, backoff) {
			return nil
		}
		backoff = retry.Next(backoff)
	}
}

func retryableVisit(err error) bool {
	if err == nil {
		return true
	}
	s := err.Error()
	if strings.Contains(s, "bad_ticket") || strings.Contains(s, "no_mapping") || strings.Contains(s, "acl") {
		return false
	}
	return true
}

func dialAndServe(ctx context.Context, cfg Config, bind *localBind, served *bool) error {
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
	if err := ensureBind(cfg, ok.Proto, bind); err != nil {
		return err
	}
	if served != nil {
		*served = true
	}
	sessCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		select {
		case <-sessCtx.Done():
		case <-sess.CloseChan():
			cancel()
		}
	}()
	if ok.Proto == "udp" {
		required := ok.UDPMode == "required" || ok.UDPMode == "uplane-required" || ok.UDPMode == "uplane"
		if required && (ok.VisitID == "" || ok.UDPCookie == "") {
			return fmt.Errorf("uplane required but missing cookie")
		}
		if ok.VisitID != "" && ok.UDPCookie != "" {
			err := serveUDPPlane(sessCtx, cfg, raw, ok.VisitID, ok.UDPCookie, ok.MappingID, bind.pc)
			if err == nil {
				return nil
			}
			if required {
				return err
			}
			return serveUDP(sessCtx, sess, bind.pc, ok.MappingID)
		}
		return serveUDP(sessCtx, sess, bind.pc, ok.MappingID)
	}
	return serveTCP(sessCtx, sess, bind.ln, ok.MappingID)
}

func ensureBind(cfg Config, proto string, bind *localBind) error {
	if bind.proto != "" && bind.proto != proto {
		return fmt.Errorf("visit proto changed from %s to %s", bind.proto, proto)
	}
	if proto == "udp" {
		if bind.pc != nil {
			return nil
		}
		addr, err := net.ResolveUDPAddr("udp", cfg.Local)
		if err != nil {
			return err
		}
		pc, err := net.ListenUDP("udp", addr)
		if err != nil {
			return err
		}
		bind.proto, bind.pc = proto, pc
		if cfg.OnListen != nil {
			cfg.OnListen("udp", pc.LocalAddr().String())
		}
		return nil
	}
	if bind.ln != nil {
		return nil
	}
	ln, err := net.Listen("tcp", cfg.Local)
	if err != nil {
		return err
	}
	bind.proto, bind.ln = proto, ln
	if cfg.OnListen != nil {
		cfg.OnListen("tcp", ln.Addr().String())
	}
	return nil
}

func serveTCP(ctx context.Context, sess *yamux.Session, ln net.Listener, mappingID string) error {
	if ln == nil {
		return fmt.Errorf("no local tcp listener")
	}
	go func() {
		<-ctx.Done()
		if tl, ok := ln.(*net.TCPListener); ok {
			_ = tl.SetDeadline(time.Now())
		}
		_ = sess.Close()
	}()
	for {
		if tl, ok := ln.(*net.TCPListener); ok {
			_ = tl.SetDeadline(time.Now().Add(time.Second))
		}
		c, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				if sess.IsClosed() {
					return fmt.Errorf("session closed")
				}
				continue
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

func serveUDP(ctx context.Context, sess *yamux.Session, pc *net.UDPConn, mappingID string) error {
	if pc == nil {
		return fmt.Errorf("no local udp listener")
	}
	go func() {
		<-ctx.Done()
		_ = pc.SetReadDeadline(time.Now())
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
		_ = pc.SetReadDeadline(time.Now().Add(time.Second))
		n, raddr, err := pc.ReadFromUDP(buf)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				if sess.IsClosed() {
					return fmt.Errorf("session closed")
				}
				continue
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
