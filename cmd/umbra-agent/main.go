package main

import (
	"crypto/tls"
	"encoding/json"
	"flag"
	"log"
	"net"
	"os"
	"runtime"
	"sync"
	"time"

	"umbra/internal/tlscfg"
	"umbra/internal/wire"
)

type mapping = wire.Mapping

func main() {
	server := flag.String("server", env("UMBRA_SERVER", "127.0.0.1:4400"), "入口控制通道")
	token := flag.String("token", os.Getenv("UMBRA_TOKEN"), "登记时签发的凭证")
	caFile := flag.String("tls-ca", env("UMBRA_TLS_CA", ""), "入口 CA 证书")
	plain := flag.Bool("plain", false, "不加密（仅调试）")
	flag.Parse()
	if *token == "" {
		log.Fatal("missing --token / UMBRA_TOKEN")
	}
	var tlsConf *tls.Config
	if !*plain {
		if *caFile == "" {
			log.Fatal("控制通道需要 --tls-ca / UMBRA_TLS_CA")
		}
		c, err := tlscfg.Client(*caFile)
		if err != nil {
			log.Fatal(err)
		}
		tlsConf = c
	}
	for {
		if err := run(*server, *token, tlsConf); err != nil {
			log.Printf("agent: %v — retry in 2s", err)
			time.Sleep(2 * time.Second)
		}
	}
}

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func run(server, token string, tlsConf *tls.Config) error {
	d := net.Dialer{Timeout: 8 * time.Second}
	raw, err := d.Dial("tcp", server)
	if err != nil {
		return err
	}
	if tlsConf != nil {
		tc := tls.Client(raw, tlsConf)
		if err := tc.Handshake(); err != nil {
			_ = raw.Close()
			return err
		}
		raw = tc
	}
	defer raw.Close()
	c := wire.NewConn(raw)
	host, _ := os.Hostname()
	if err := c.SendJSON("Enroll", map[string]string{
		"bootstrap": token,
		"hostname":  host,
		"os":        runtime.GOOS,
		"arch":      runtime.GOARCH,
		"version":   "0.5.0",
	}); err != nil {
		return err
	}
	have := map[string]mapping{}
	var haveMu sync.Mutex
	streams := sync.Map{}

	for {
		f, err := c.Read()
		if err != nil {
			return err
		}
		switch f.Kind {
		case wire.KindJSON:
			if err := onJSON(c, f, have, &haveMu, &streams); err != nil {
				return err
			}
		case wire.KindData:
			if v, ok := streams.Load(f.StreamID); ok {
				if conn, ok := v.(net.Conn); ok {
					_, _ = conn.Write(f.Payload)
				} else if u, ok := v.(*net.UDPConn); ok {
					_, _ = u.Write(f.Payload)
				}
			}
		case wire.KindClose:
			if v, ok := streams.LoadAndDelete(f.StreamID); ok {
				switch x := v.(type) {
				case net.Conn:
					_ = x.Close()
				case *net.UDPConn:
					_ = x.Close()
				}
			}
		}
	}
}

func onJSON(c *wire.Conn, f wire.Frame, have map[string]mapping, mu *sync.Mutex, streams *sync.Map) error {
	switch f.Type {
	case "EnrollOk":
		var b struct {
			AgentID string `json:"agent_id"`
		}
		_ = json.Unmarshal(f.Body, &b)
		return c.SendJSON("Hello", map[string]string{"agent_id": b.AgentID, "version": "0.5.0"})
	case "HelloOk":
		var b struct {
			Mappings []mapping `json:"mappings"`
		}
		if err := json.Unmarshal(f.Body, &b); err != nil {
			return err
		}
		align(have, mu, b.Mappings)
		for _, m := range b.Mappings {
			_ = c.SendJSON("MappingAck", map[string]any{"id": m.ID, "ok": true})
		}
	case "MappingSync":
		var b struct {
			Upsert []mapping `json:"upsert"`
			Delete []string  `json:"delete"`
		}
		_ = json.Unmarshal(f.Body, &b)
		mu.Lock()
		for _, id := range b.Delete {
			delete(have, id)
		}
		mu.Unlock()
		align(have, mu, b.Upsert)
		for _, m := range b.Upsert {
			_ = c.SendJSON("MappingAck", map[string]any{"id": m.ID, "ok": true})
		}
		for _, id := range b.Delete {
			_ = c.SendJSON("MappingAck", map[string]any{"id": id, "ok": true})
		}
	case "OpenStream":
		var b struct {
			StreamID  uint32 `json:"stream_id"`
			MappingID string `json:"mapping_id"`
			Proto     string `json:"proto"`
		}
		if err := json.Unmarshal(f.Body, &b); err != nil {
			return err
		}
		mu.Lock()
		m, ok := have[b.MappingID]
		mu.Unlock()
		if !ok {
			_ = c.SendClose(b.StreamID)
			return nil
		}
		return openLocal(c, streams, b.StreamID, m, b.Proto)
	case "Revoked":
		log.Fatal("credential revoked")
	}
	return nil
}

func align(have map[string]mapping, mu *sync.Mutex, want []mapping) {
	mu.Lock()
	defer mu.Unlock()
	next := map[string]mapping{}
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

func openLocal(c *wire.Conn, streams *sync.Map, sid uint32, m mapping, proto string) error {
	addr := net.JoinHostPort(m.LocalHost, itoa(m.LocalPort))
	if proto == "udp" || m.Proto == "udp" {
		raddr, err := net.ResolveUDPAddr("udp", addr)
		if err != nil {
			_ = c.SendClose(sid)
			return nil
		}
		u, err := net.DialUDP("udp", nil, raddr)
		if err != nil {
			_ = c.SendClose(sid)
			return nil
		}
		streams.Store(sid, u)
		go func() {
			buf := make([]byte, 64*1024)
			for {
				n, err := u.Read(buf)
				if n > 0 {
					if err := c.SendData(sid, buf[:n]); err != nil {
						_ = u.Close()
						return
					}
				}
				if err != nil {
					streams.Delete(sid)
					_ = c.SendClose(sid)
					_ = u.Close()
					return
				}
			}
		}()
		return nil
	}
	conn, err := net.DialTimeout("tcp", addr, 8*time.Second)
	if err != nil {
		_ = c.SendClose(sid)
		return nil
	}
	streams.Store(sid, conn)
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := conn.Read(buf)
			if n > 0 {
				if err := c.SendData(sid, buf[:n]); err != nil {
					_ = conn.Close()
					return
				}
			}
			if err != nil {
				streams.Delete(sid)
				_ = c.SendClose(sid)
				_ = conn.Close()
				return
			}
		}
	}()
	return nil
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
