package node

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"runtime"
	"sync"
	"time"

	"github.com/hashicorp/yamux"

	"umbra/internal/muxcfg"
	"umbra/internal/preface"
	"umbra/internal/wire"
	"umbra/internal/xfer"
)

const Version = "0.6.0"

type session struct {
	server string
	raw    net.Conn
	id     string
	have   map[string]wire.Mapping
	haveMu *sync.Mutex
	ctx    context.Context
}

func Run(server, token string, tlsConf *tls.Config) error {
	d := net.Dialer{Timeout: 8 * time.Second}
	raw, err := d.Dial("tcp", server)
	if err != nil {
		return err
	}
	_ = raw.SetDeadline(time.Now().Add(8 * time.Second))
	if tlsConf != nil {
		tc := tls.Client(raw, tlsConf)
		if err := tc.Handshake(); err != nil {
			_ = raw.Close()
			return err
		}
		raw = tc
	}
	if err := preface.Write(raw, preface.KindNode, token); err != nil {
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
	host, _ := os.Hostname()
	if err := wc.SendJSON("Enroll", map[string]string{
		"bootstrap": token,
		"hostname":  host,
		"os":        runtime.GOOS,
		"arch":      runtime.GOARCH,
		"version":   Version,
	}); err != nil {
		return err
	}

	have := map[string]wire.Mapping{}
	var haveMu sync.Mutex
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rt := &session{server: server, raw: raw, have: have, haveMu: &haveMu, ctx: ctx}
	go acceptStreams(sess, have, &haveMu)

	for {
		env, err := wc.Read()
		if err != nil {
			return err
		}
		if err := onJSON(rt, wc, env); err != nil {
			return err
		}
	}
}

func acceptStreams(sess *yamux.Session, have map[string]wire.Mapping, mu *sync.Mutex) {
	for {
		st, err := sess.AcceptStream()
		if err != nil {
			return
		}
		go handleStream(st, have, mu)
	}
}

func handleStream(st net.Conn, have map[string]wire.Mapping, mu *sync.Mutex) {
	defer st.Close()
	_ = st.SetDeadline(time.Now().Add(8 * time.Second))
	o, err := wire.ReadOpen(st)
	if err != nil {
		return
	}
	_ = st.SetDeadline(time.Time{})
	mu.Lock()
	m, ok := have[o.MappingID]
	mu.Unlock()
	if !ok || !m.Enabled {
		return
	}
	addr := net.JoinHostPort(m.LocalHost, itoa(m.LocalPort))
	proto := m.Proto
	if o.Proto != "" && o.Proto != m.Proto {
		return
	}
	if proto == "udp" {
		relayUDP(st, addr)
		return
	}
	conn, err := net.DialTimeout("tcp", addr, 8*time.Second)
	if err != nil {
		return
	}
	xfer.CopyBidirectional(conn, st, nil, nil)
}

func relayUDP(st net.Conn, addr string) {
	raddr, err := net.ResolveUDPAddr("udp", addr)
	if err != nil {
		return
	}
	u, err := net.DialUDP("udp", nil, raddr)
	if err != nil {
		return
	}
	defer u.Close()
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		buf := make([]byte, 64*1024)
		for {
			n, err := u.Read(buf)
			if n > 0 {
				if err := wire.WriteDatagram(st, buf[:n]); err != nil {
					_ = u.Close()
					return
				}
			}
			if err != nil {
				_ = st.Close()
				return
			}
		}
	}()
	go func() {
		defer wg.Done()
		for {
			p, err := wire.ReadDatagram(st)
			if err != nil {
				_ = u.Close()
				return
			}
			if _, err := u.Write(p); err != nil {
				_ = st.Close()
				return
			}
		}
	}()
	wg.Wait()
}

func onJSON(rt *session, c *wire.Conn, env wire.Envelope) error {
	switch env.Type {
	case "EnrollOk":
		var b struct {
			NodeID string `json:"node_id"`
		}
		_ = json.Unmarshal(env.Body, &b)
		rt.id = b.NodeID
		return c.SendJSON("Hello", map[string]string{"node_id": b.NodeID, "version": Version})
	case "HelloOk":
		var b struct {
			Mappings  []wire.Mapping `json:"mappings"`
			UDPCookie string         `json:"udp_cookie"`
			UDPMode   string         `json:"udp_mode"`
		}
		if err := json.Unmarshal(env.Body, &b); err != nil {
			return err
		}
		align(rt.have, rt.haveMu, b.Mappings)
		for _, m := range b.Mappings {
			_ = c.SendJSON("MappingAck", map[string]any{"id": m.ID, "ok": true})
		}
		if b.UDPMode == "required" || b.UDPMode == "uplane-required" || b.UDPMode == "uplane" {
			if b.UDPCookie == "" || rt.id == "" {
				return fmt.Errorf("uplane required but missing cookie")
			}
		}
		if b.UDPCookie != "" && rt.id != "" {
			go rt.runUDP(b.UDPCookie, b.UDPMode)
		}
	case "MappingSync":
		var b struct {
			Upsert []wire.Mapping `json:"upsert"`
			Delete []string       `json:"delete"`
		}
		_ = json.Unmarshal(env.Body, &b)
		rt.haveMu.Lock()
		for _, id := range b.Delete {
			delete(rt.have, id)
		}
		rt.haveMu.Unlock()
		align(rt.have, rt.haveMu, b.Upsert)
		for _, m := range b.Upsert {
			_ = c.SendJSON("MappingAck", map[string]any{"id": m.ID, "ok": true})
		}
		for _, id := range b.Delete {
			_ = c.SendJSON("MappingAck", map[string]any{"id": id, "ok": true})
		}
	case "Dropped":
		return fmt.Errorf("dropped")
	case "Revoked":
		return fmt.Errorf("credential revoked")
	}
	return nil
}

func align(have map[string]wire.Mapping, mu *sync.Mutex, want []wire.Mapping) {
	mu.Lock()
	defer mu.Unlock()
	next := map[string]wire.Mapping{}
	for _, m := range want {
		if m.Enabled {
			next[m.ID] = m
		}
	}
	for id := range have {
		if _, ok := next[id]; !ok {
			delete(have, id)
		}
	}
	for id, m := range next {
		have[id] = m
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [16]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
