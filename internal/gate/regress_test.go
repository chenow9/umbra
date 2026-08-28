package gate

import (
	"context"
	"io"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hashicorp/yamux"

	"umbra/internal/muxcfg"
	"umbra/internal/node"
	"umbra/internal/preface"
	"umbra/internal/retry"
	"umbra/internal/stealth"
	"umbra/internal/wire"
)

func TestStreamFloodAfterAuthIsBounded(t *testing.T) {
	s, addr := startGate(t)
	s.SetToken("tok", "nde1")
	raw, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	if err := preface.Write(raw, preface.KindNode, "tok"); err != nil {
		t.Fatal(err)
	}
	sess, err := yamux.Client(raw, muxcfg.Config())
	if err != nil {
		t.Fatal(err)
	}
	defer sess.Close()
	st, err := sess.OpenStream()
	if err != nil {
		t.Fatal(err)
	}
	wc := wire.NewConn(st)
	if err := wc.SendJSON("Enroll", map[string]string{"hostname": "x", "os": "linux", "arch": "amd64"}); err != nil {
		t.Fatal(err)
	}
	if _, err := wc.Read(); err != nil {
		t.Fatal(err)
	}
	if err := wc.SendJSON("Hello", map[string]string{"node_id": "nde1", "version": "test"}); err != nil {
		t.Fatal(err)
	}
	waitOnline(t, s, "nde1")

	const n = 48
	var opened atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			st, err := sess.OpenStream()
			if err != nil {
				return
			}
			opened.Add(1)
			_ = st.SetWriteDeadline(time.Now().Add(200 * time.Millisecond))
			_, _ = st.Write(make([]byte, 256*1024))
			_ = st.Close()
		}()
	}
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
	}
	_ = sess.Close()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("stream flood did not unblock after session close")
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if s.sessionHeld("127.0.0.1") == 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if held := s.sessionHeld("127.0.0.1"); held != 0 {
		t.Fatalf("session quota leaked after flood: %d opened=%d", held, opened.Load())
	}
	go func() { _ = node.Run(addr, "tok", nil) }()
	waitOnline(t, s, "nde1")
}

func TestRevokeDuringHandshakeRejectsEnroll(t *testing.T) {
	old := handshakeDeadlineNs.Swap(int64(8 * time.Second))
	defer handshakeDeadlineNs.Store(old)
	s, addr := startGate(t)
	s.SetToken("tok", "nde1")
	raw, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	if err := preface.Write(raw, preface.KindNode, "tok"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if s.sessionHeld("127.0.0.1") > 0 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if s.sessionHeld("127.0.0.1") == 0 {
		t.Fatal("UMB1 did not promote to session")
	}
	s.Revoke("nde1")
	sess, err := yamux.Client(raw, muxcfg.Config())
	if err != nil {
		return
	}
	defer sess.Close()
	st, err := sess.OpenStream()
	if err != nil {
		return
	}
	wc := wire.NewConn(st)
	if err := wc.SendJSON("Enroll", map[string]string{"hostname": "x", "os": "linux", "arch": "amd64"}); err != nil {
		return
	}
	_ = st.SetReadDeadline(time.Now().Add(2 * time.Second))
	env, err := wc.Read()
	if err == nil && env.Type == "EnrollOk" {
		t.Fatal("enroll after revoke must not succeed")
	}
	for _, n := range s.Status().Nodes {
		if n.ID == "nde1" && n.Online {
			t.Fatal("revoked handshake must not publish a node session")
		}
	}
	if s.LookupToken("tok") != "" {
		t.Fatal("revoked token must stay deleted")
	}
}

func TestRevokeLinearizedAgainstEnroll(t *testing.T) {
	old := handshakeDeadlineNs.Swap(int64(8 * time.Second))
	defer handshakeDeadlineNs.Store(old)
	s, addr := startGate(t)
	for round := 0; round < 60; round++ {
		id := "nde" + itoa(round)
		tok := "tok" + itoa(round)
		s.SetToken(tok, id)
		raw, err := net.Dial("tcp", addr)
		if err != nil {
			t.Fatal(err)
		}
		held := s.sessionHeld("127.0.0.1")
		if err := preface.Write(raw, preface.KindNode, tok); err != nil {
			_ = raw.Close()
			t.Fatal(err)
		}
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			if s.sessionHeld("127.0.0.1") > held {
				break
			}
			time.Sleep(2 * time.Millisecond)
		}
		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			s.Revoke(id)
		}()
		go func() {
			defer wg.Done()
			<-start
			sess, err := yamux.Client(raw, muxcfg.Config())
			if err != nil {
				return
			}
			defer sess.Close()
			st, err := sess.OpenStream()
			if err != nil {
				return
			}
			wc := wire.NewConn(st)
			_ = wc.SendJSON("Enroll", map[string]string{"hostname": "x", "os": "linux", "arch": "amd64"})
			_ = wc.SendJSON("Hello", map[string]string{"node_id": id, "version": "test"})
			_ = st.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
			_, _ = wc.Read()
		}()
		close(start)
		wg.Wait()
		if s.LookupToken(tok) != "" {
			_ = raw.Close()
			t.Fatalf("round %d: token survived revoke", round)
		}
		for _, n := range s.Status().Nodes {
			if n.ID == id {
				_ = raw.Close()
				t.Fatalf("round %d: node still published after revoke: online=%v", round, n.Online)
			}
		}
		_ = raw.Close()
		wait := time.Now().Add(2 * time.Second)
		for time.Now().Before(wait) && s.sessionHeld("127.0.0.1") > held {
			time.Sleep(2 * time.Millisecond)
		}
	}
}

func TestExpiryDuringHandshakeRejectsEnroll(t *testing.T) {
	old := handshakeDeadlineNs.Swap(int64(8 * time.Second))
	defer handshakeDeadlineNs.Store(old)
	s, addr := startGate(t)
	h := TicketHash("tok")
	s.SetTokenHashUntil(h, "nde1", time.Now().Add(80*time.Millisecond))
	raw, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	if err := preface.Write(raw, preface.KindNode, "tok"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if s.sessionHeld("127.0.0.1") > 0 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(120 * time.Millisecond)
	sess, err := yamux.Client(raw, muxcfg.Config())
	if err != nil {
		return
	}
	defer sess.Close()
	st, err := sess.OpenStream()
	if err != nil {
		return
	}
	wc := wire.NewConn(st)
	_ = wc.SendJSON("Enroll", map[string]string{"hostname": "x"})
	_ = st.SetReadDeadline(time.Now().Add(2 * time.Second))
	env, err := wc.Read()
	if err == nil && env.Type == "EnrollOk" {
		t.Fatal("enroll after expiry must not succeed")
	}
	for _, n := range s.Status().Nodes {
		if n.ID == "nde1" && n.Online {
			t.Fatal("expired handshake must not publish a node session")
		}
	}
}

func TestRotateExpiredTokenHasNoGrace(t *testing.T) {
	s := New("127.0.0.1", stealth.New(false))
	oldH, newH := TicketHash("old"), TicketHash("new")
	s.SetTokenHashUntil(oldH, "nde1", time.Now().Add(30*time.Millisecond))
	time.Sleep(50 * time.Millisecond)
	if s.LookupToken("old") != "" {
		t.Fatal("old token should already be expired")
	}
	s.RotateTokenUntil("nde1", oldH, newH, time.Now().Add(time.Hour), TokenGrace)
	if s.LookupToken("old") != "" {
		t.Fatal("rotate must not revive an expired token")
	}
	if s.LookupToken("new") != "nde1" {
		t.Fatal("new token must be installed")
	}
}

func TestBlackholePeerReleasesQuota(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				buf := make([]byte, 32*1024)
				for {
					_, err := c.Read(buf)
					if err != nil {
						return
					}
				}
			}(c)
		}
	}()
	backendPort := ln.Addr().(*net.TCPAddr).Port
	s, addr := startGate(t)
	s.SetToken("tok", "nde1")
	pub := pickPort(t)
	port := pub
	s.PutMappings("nde1", []wire.Mapping{{
		ID: "map_bh", Name: "t", Proto: "tcp", Mode: "public",
		EntryPort: &port, LocalHost: "127.0.0.1", LocalPort: backendPort,
		Enabled: true, MaxConns: 2, IdleTimeoutSec: 1,
	}})
	go func() { _ = node.Run(addr, "tok", nil) }()
	waitOnline(t, s, "nde1")
	c, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", itoa(pub)), 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	payload := make([]byte, 256*1024)
	_, _ = c.Write(payload)
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		if s.MappingStats()["map_bh"].Active == 0 && s.splices.Load() == 0 {
			return
		}
		time.Sleep(40 * time.Millisecond)
	}
	t.Fatalf("blackhole leaked active=%d splices=%d", s.MappingStats()["map_bh"].Active, s.splices.Load())
}

func TestReconnectHerdLastWriterWins(t *testing.T) {
	s, addr := startGate(t)
	s.SetToken("tok", "nde1")
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	const n = 8
	for i := 0; i < n; i++ {
		go func() {
			backoff := retry.Initial
			for ctx.Err() == nil {
				_ = node.Run(addr, "tok", nil)
				if !retry.Sleep(ctx, backoff) {
					return
				}
				backoff = retry.Next(backoff)
			}
		}()
	}
	waitOnline(t, s, "nde1")
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		online := 0
		for _, a := range s.Status().Nodes {
			if a.ID == "nde1" && a.Online {
				online++
			}
		}
		if online != 1 {
			t.Fatalf("online copies=%d want 1", online)
		}
		time.Sleep(40 * time.Millisecond)
	}
	s.Disconnect("nde1")
	waitOnline(t, s, "nde1")
	cancel()
	s.Revoke("nde1")
	wait := time.Now().Add(2 * time.Second)
	for time.Now().Before(wait) {
		if s.sessionHeld("127.0.0.1") == 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("session quota leaked: %d", s.sessionHeld("127.0.0.1"))
}

func TestSoakCycles(t *testing.T) {
	d := 2 * time.Second
	if v := soakDuration(); v > 0 && v < 24*time.Hour {
		d = v
	}
	echo, echoPort := startEchoTCP(t)
	defer echo.Close()
	s, addr := startGate(t)
	s.SetToken("tok", "nde1")
	pub := pickPort(t)
	port := pub
	s.PutMappings("nde1", []wire.Mapping{{
		ID: "map_soak", Name: "t", Proto: "tcp", Mode: "public",
		EntryPort: &port, LocalHost: "127.0.0.1", LocalPort: echoPort,
		Enabled: true, MaxConns: 8, IdleTimeoutSec: 1,
	}})
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() {
		cancel()
		s.Disconnect("nde1")
		s.StopAccept()
	})
	go func() {
		for ctx.Err() == nil {
			_ = node.Run(addr, "tok", nil)
			if !retry.Sleep(ctx, 30*time.Millisecond) {
				return
			}
		}
	}()
	waitOnline(t, s, "nde1")
	deadline := time.Now().Add(d)
	rounds := 0
	for time.Now().Before(deadline) {
		c, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", itoa(pub)), time.Second)
		if err != nil {
			time.Sleep(40 * time.Millisecond)
			continue
		}
		msg := []byte("soak")
		_, _ = c.Write(msg)
		buf := make([]byte, len(msg))
		_ = c.SetReadDeadline(time.Now().Add(time.Second))
		_, err = io.ReadFull(c, buf)
		_ = c.Close()
		if err != nil {
			time.Sleep(40 * time.Millisecond)
			continue
		}
		s.Disconnect("nde1")
		waitOnline(t, s, "nde1")
		rounds++
	}
	if rounds == 0 {
		t.Fatal("soak completed zero successful cycles")
	}
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if s.MappingStats()["map_soak"].Active == 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("soak leaked active=%d after %d rounds", s.MappingStats()["map_soak"].Active, rounds)
}

func soakDuration() time.Duration {
	s := os.Getenv("UMBRA_SOAK")
	if s == "" || s == "24h" {
		return 0
	}
	d, err := time.ParseDuration(s)
	if err != nil {
		return 0
	}
	return d
}
