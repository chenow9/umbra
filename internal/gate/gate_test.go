package gate

import (
	"bytes"
	"context"
	"crypto/tls"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/hashicorp/yamux"

	"umbra/internal/muxcfg"
	"umbra/internal/node"
	"umbra/internal/preface"
	"umbra/internal/stealth"
	"umbra/internal/tlscfg"
	"umbra/internal/uplane"
	"umbra/internal/visit"
	"umbra/internal/wire"
)

func startEchoTCP(t *testing.T) (net.Listener, int) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				_, _ = io.Copy(c, c)
			}(c)
		}
	}()
	return ln, ln.Addr().(*net.TCPAddr).Port
}

func startEchoUDP(t *testing.T) (*net.UDPConn, int) {
	t.Helper()
	addr, err := net.ResolveUDPAddr("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	pc, err := net.ListenUDP("udp", addr)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		buf := make([]byte, 64*1024)
		for {
			n, raddr, err := pc.ReadFromUDP(buf)
			if err != nil {
				return
			}
			_, _ = pc.WriteToUDP(buf[:n], raddr)
		}
	}()
	return pc, pc.LocalAddr().(*net.UDPAddr).Port
}

func startSinkUDP(t *testing.T) (*net.UDPConn, *atomic.Int64, int) {
	t.Helper()
	addr, err := net.ResolveUDPAddr("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	pc, err := net.ListenUDP("udp", addr)
	if err != nil {
		t.Fatal(err)
	}
	got := new(atomic.Int64)
	go func() {
		buf := make([]byte, 64*1024)
		for {
			n, _, err := pc.ReadFromUDP(buf)
			if err != nil {
				return
			}
			if n > 0 {
				got.Add(1)
			}
		}
	}()
	return pc, got, pc.LocalAddr().(*net.UDPAddr).Port
}

func startGate(t *testing.T) (*Server, string) {
	t.Helper()
	s := New("127.0.0.1", stealth.New(false))
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close(); s.StopAccept() })
	if pc, err := net.ListenPacket("udp", ln.Addr().String()); err != nil {
		t.Fatal(err)
	} else {
		t.Cleanup(func() { _ = pc.Close() })
		s.AttachUPlane(pc)
	}
	go func() { _ = s.ServeControl(ln) }()
	return s, ln.Addr().String()
}

func startTLSGate(t *testing.T, mode UDPMode) (*Server, string, *tls.Config) {
	t.Helper()
	bundle, err := tlscfg.Ensure(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := New("127.0.0.1", stealth.New(false))
	s.SetTLS(bundle.TLS.Clone())
	s.SetUDPMode(mode)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close(); s.StopAccept() })
	pc, err := net.ListenPacket("udp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	s.AttachUPlane(pc)
	go func() { _ = s.ServeControl(ln) }()
	cli, err := tlscfg.Client(bundle.CAFile)
	if err != nil {
		t.Fatal(err)
	}
	return s, ln.Addr().String(), cli
}

func waitUDP(t *testing.T, s *Server, id string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if s.nodeUDPReady(id) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("udp data plane not bound")
}

func waitOnline(t *testing.T, s *Server, id string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		st := s.Status()
		for _, a := range st.Nodes {
			if a.ID == id && a.Online {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("agent not online")
}

func pickPort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	return p
}

func TestTCPForwardCountsBothDirections(t *testing.T) {
	echo, echoPort := startEchoTCP(t)
	defer echo.Close()
	s, addr := startGate(t)
	s.SetToken("tok", "nde1")
	pub := pickPort(t)
	port := pub
	s.PutMappings("nde1", []wire.Mapping{{
		ID: "map_tcp", Name: "t", Proto: "tcp", Mode: "public",
		EntryPort: &port, LocalHost: "127.0.0.1", LocalPort: echoPort,
		Enabled: true, MaxConns: 8, IdleTimeoutSec: 30,
	}})
	go func() { _ = node.Run(addr, "tok", nil) }()
	waitOnline(t, s, "nde1")
	c, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", itoa(pub)), 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	msg := []byte("hello-umbra-count")
	if _, err := c.Write(msg); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, len(msg))
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := io.ReadFull(c, buf); err != nil {
		t.Fatal(err)
	}
	if string(buf) != string(msg) {
		t.Fatalf("echo %q", buf)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		st := s.MappingStats()["map_tcp"]
		if st.In >= int64(len(msg)) && st.Out >= int64(len(msg)) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	st := s.MappingStats()["map_tcp"]
	t.Fatalf("stats in=%d out=%d want >=%d", st.In, st.Out, len(msg))
}

func TestTCPDropMaxConnsCounted(t *testing.T) {
	echo, echoPort := startEchoTCP(t)
	defer echo.Close()
	s, addr := startGate(t)
	s.SetToken("tok", "nde1")
	pub := pickPort(t)
	port := pub
	s.PutMappings("nde1", []wire.Mapping{{
		ID: "map_cap", Name: "t", Proto: "tcp", Mode: "public",
		EntryPort: &port, LocalHost: "127.0.0.1", LocalPort: echoPort,
		Enabled: true, MaxConns: 1, IdleTimeoutSec: 0,
	}})
	go func() { _ = node.Run(addr, "tok", nil) }()
	waitOnline(t, s, "nde1")
	c1, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", itoa(pub)), 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c1.Close()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if s.MappingStats()["map_cap"].Active >= 1 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	c2, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", itoa(pub)), 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 8)
	_ = c2.SetReadDeadline(time.Now().Add(time.Second))
	_, _ = c2.Read(buf)
	_ = c2.Close()
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		st := s.MappingStats()["map_cap"]
		if st.TCPDropMaxConns >= 1 && st.LastDrop == "maxconns" {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	st := s.MappingStats()["map_cap"]
	t.Fatalf("tcpDropMaxConns=%d last=%q", st.TCPDropMaxConns, st.LastDrop)
}

func TestUDPIdleTimerRefreshDoesNotDrop(t *testing.T) {
	e := &entry{udpSess: map[string]*udpSess{}}
	e.active.Store(1)
	sess := &udpSess{idle: 40 * time.Millisecond}
	e.udpSess["k"] = sess
	e.mu.Lock()
	sess.touchLocked(e, "k")
	e.mu.Unlock()
	for i := 0; i < 15; i++ {
		time.Sleep(15 * time.Millisecond)
		e.mu.Lock()
		sess.touchLocked(e, "k")
		e.mu.Unlock()
	}
	e.mu.Lock()
	_, ok := e.udpSess["k"]
	e.mu.Unlock()
	if !ok {
		t.Fatal("stale timer closed an active udp session")
	}
	time.Sleep(120 * time.Millisecond)
	e.mu.Lock()
	_, ok = e.udpSess["k"]
	e.mu.Unlock()
	if ok {
		t.Fatal("udp session should expire after idle")
	}
}

func TestUDPForwardCounts(t *testing.T) {
	echo, echoPort := startEchoUDP(t)
	defer echo.Close()
	s, addr, tlsConf := startTLSGate(t, UDPRequired)
	s.SetToken("tok", "nde1")
	pub := pickPort(t)
	port := pub
	s.PutMappings("nde1", []wire.Mapping{{
		ID: "map_udp", Name: "u", Proto: "udp", Mode: "public",
		EntryPort: &port, LocalHost: "127.0.0.1", LocalPort: echoPort,
		Enabled: true, MaxConns: 8, IdleTimeoutSec: 30,
	}})
	go func() { _ = node.Run(addr, "tok", tlsConf) }()
	waitOnline(t, s, "nde1")
	waitUDP(t, s, "nde1")
	pc, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	msg := []byte("udp-ping")
	_, err = pc.WriteToUDP(msg, &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: pub})
	if err != nil {
		t.Fatal(err)
	}
	_ = pc.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 64)
	n, _, err := pc.ReadFromUDP(buf)
	if err != nil {
		t.Fatal(err)
	}
	if string(buf[:n]) != string(msg) {
		t.Fatalf("udp %q", buf[:n])
	}
	st := s.MappingStats()["map_udp"]
	if st.In < int64(len(msg)) || st.Out < int64(len(msg)) {
		t.Fatalf("udp stats in=%d out=%d pkts in=%d out=%d", st.In, st.Out, st.PacketsIn, st.PacketsOut)
	}
	if st.UDPVia != "uplane" {
		t.Fatalf("udp via %q want uplane", st.UDPVia)
	}
}

func TestVisitorTCP(t *testing.T) {
	echo, echoPort := startEchoTCP(t)
	defer echo.Close()
	s, addr := startGate(t)
	s.SetToken("tok", "nde1")
	s.PutMappings("nde1", []wire.Mapping{{
		ID: "map_vis", Name: "v", Proto: "tcp", Mode: "visitor",
		LocalHost: "127.0.0.1", LocalPort: echoPort,
		Enabled: true, MaxConns: 8, IdleTimeoutSec: 30,
	}})
	ticket := "umbra_vis_test"
	s.SetTicket(TicketHash(ticket), "map_vis", time.Now().Add(time.Hour))
	go func() { _ = node.Run(addr, "tok", nil) }()
	waitOnline(t, s, "nde1")

	ready := make(chan string, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		_ = visit.Run(ctx, visit.Config{
			Server: addr, Ticket: ticket, Local: "127.0.0.1:0",
			OnListen: func(_, a string) { ready <- a },
		})
	}()
	var local string
	select {
	case local = <-ready:
	case <-time.After(3 * time.Second):
		t.Fatal("visit did not listen")
	}
	c, err := net.DialTimeout("tcp", local, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	msg := []byte("via-visitor")
	if _, err := c.Write(msg); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, len(msg))
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := io.ReadFull(c, buf); err != nil {
		t.Fatal(err)
	}
	if string(buf) != string(msg) {
		t.Fatalf("got %q", buf)
	}
	st := s.MappingStats()["map_vis"]
	if st.In < int64(len(msg)) || st.Out < int64(len(msg)) {
		t.Fatalf("visitor stats in=%d out=%d", st.In, st.Out)
	}
}

func TestRevokeRejectsOldToken(t *testing.T) {
	s, addr := startGate(t)
	s.SetToken("tok", "nde1")
	done := make(chan error, 1)
	go func() { done <- node.Run(addr, "tok", nil) }()
	waitOnline(t, s, "nde1")
	s.Revoke("nde1")
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("session not closed on revoke")
	}
	errCh := make(chan error, 1)
	go func() { errCh <- node.Run(addr, "tok", nil) }()
	deadline := time.Now().Add(800 * time.Millisecond)
	for time.Now().Before(deadline) {
		st := s.Status()
		for _, a := range st.Nodes {
			if a.ID == "nde1" && a.Online {
				t.Fatal("revoked token enrolled again")
			}
		}
		time.Sleep(40 * time.Millisecond)
	}
}

func TestHandshakeQuotaReleasedAfterUMB1(t *testing.T) {
	s, addr := startGate(t)
	s.SetToken("tok", "nde1")
	held := make([]net.Conn, 0, maxHandshakePerIP)
	t.Cleanup(func() {
		for _, c := range held {
			_ = c.Close()
		}
	})
	for i := 0; i < maxHandshakePerIP; i++ {
		c, err := net.Dial("tcp", addr)
		if err != nil {
			t.Fatal(err)
		}
		if err := preface.Write(c, preface.KindNode, "tok"); err != nil {
			t.Fatal(err)
		}
		held = append(held, c)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if s.handshakeHeld("127.0.0.1") == 0 && s.sessionHeld("127.0.0.1") == maxHandshakePerIP {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if n := s.handshakeHeld("127.0.0.1"); n != 0 {
		t.Fatalf("handshake quota still held: %d", n)
	}
	if n := s.sessionHeld("127.0.0.1"); n != maxHandshakePerIP {
		t.Fatalf("session held=%d want %d", n, maxHandshakePerIP)
	}
	done := make(chan error, 1)
	go func() { done <- node.Run(addr, "tok", nil) }()
	waitOnline(t, s, "nde1")
}

func TestSetupDeadlineClosesIncompleteSession(t *testing.T) {
	old := handshakeDeadlineNs.Swap(int64(250 * time.Millisecond))
	defer handshakeDeadlineNs.Store(old)
	s, addr := startGate(t)
	s.SetToken("tok", "nde1")
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := preface.Write(c, preface.KindNode, "tok"); err != nil {
		t.Fatal(err)
	}
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 1)
	_, err = c.Read(buf)
	if err == nil {
		t.Fatal("incomplete session should be closed by setup deadline")
	}
}

func TestRestoreTokensRejectsRaw(t *testing.T) {
	s := New("127.0.0.1", stealth.New(false))
	if err := s.RestoreTokens(map[string]string{"umbra_boot_rawtoken": "nde1"}); err == nil {
		t.Fatal("raw token snapshot must be rejected")
	}
	if s.lookupToken("umbra_boot_rawtoken") != "" {
		t.Fatal("raw token must not enroll")
	}
	h := TicketHash("good-token")
	if err := s.RestoreTokens(map[string]string{h: "nde1"}); err != nil {
		t.Fatal(err)
	}
	if s.lookupToken("good-token") != "nde1" {
		t.Fatal("hashed snapshot should restore")
	}
}

func TestIPQuotaLastReleaseConcurrentAdmit(t *testing.T) {
	const ip = "203.0.113.9"
	for round := 0; round < 400; round++ {
		q := newIPQuota(1024, 128)
		if !q.acquire(ip) {
			t.Fatal("seed acquire")
		}
		const n = 64
		start := make(chan struct{})
		var wg sync.WaitGroup
		got := make([]bool, n)
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			q.release(ip)
		}()
		wg.Add(n)
		for i := 0; i < n; i++ {
			go func(i int) {
				defer wg.Done()
				<-start
				got[i] = q.acquire(ip)
			}(i)
		}
		close(start)
		wg.Wait()
		alive := 0
		for _, ok := range got {
			if ok {
				alive++
			}
		}
		held := q.held(ip)
		if held != alive {
			t.Fatalf("round %d held=%d admits=%d (per-IP counter deleted under a live session)", round, held, alive)
		}
		if held > 128 {
			t.Fatalf("per-ip cap broken: %d", held)
		}
	}
}

func TestListenRetriesAfterTransientFailure(t *testing.T) {
	old := listenTCPFn.Load()
	var n atomic.Int32
	listenTCPFn.Store(listenTCPFunc(func(network, addr string) (net.Listener, error) {
		if n.Add(1) == 1 {
			return nil, syscall.EADDRINUSE
		}
		return net.Listen(network, addr)
	}))
	defer listenTCPFn.Store(old)

	s := New("127.0.0.1", stealth.New(false))
	t.Cleanup(func() { s.StopAccept() })
	port := pickPort(t)
	s.PutMappings("nde1", []wire.Mapping{{
		ID: "map_retry", Name: "t", Proto: "tcp", Mode: "public",
		EntryPort: &port, LocalHost: "127.0.0.1", LocalPort: 1,
		Enabled: true, MaxConns: 1, IdleTimeoutSec: 30,
	}})
	st := s.MappingStats()["map_retry"]
	if st.Error == "" || st.Listening {
		t.Fatalf("want listen error on first bind, got %+v", st)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		st = s.MappingStats()["map_retry"]
		if st.Listening && st.Error == "" {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("listener did not recover: listening=%v err=%q attempts=%d", st.Listening, st.Error, n.Load())
}

func TestRetryDoesNotPublishAfterStopAccept(t *testing.T) {
	old := listenTCPFn.Load()
	var n atomic.Int32
	started := make(chan struct{})
	release := make(chan struct{})
	listenTCPFn.Store(listenTCPFunc(func(network, addr string) (net.Listener, error) {
		if n.Add(1) == 1 {
			return nil, syscall.EADDRINUSE
		}
		select {
		case started <- struct{}{}:
		default:
		}
		<-release
		return net.Listen(network, addr)
	}))
	defer listenTCPFn.Store(old)

	s := New("127.0.0.1", stealth.New(false))
	port := pickPort(t)
	s.PutMappings("nde1", []wire.Mapping{{
		ID: "map_stop", Name: "t", Proto: "tcp", Mode: "public",
		EntryPort: &port, LocalHost: "127.0.0.1", LocalPort: 1,
		Enabled: true, MaxConns: 1, IdleTimeoutSec: 30,
	}})
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("retry did not reach bind")
	}
	s.StopAccept()
	close(release)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		st := s.MappingStats()["map_stop"]
		if st.Listening {
			t.Fatal("listener published after StopAccept")
		}
		time.Sleep(20 * time.Millisecond)
	}
	c, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", itoa(port)), 200*time.Millisecond)
	if err == nil {
		_ = c.Close()
		t.Fatal("port still accepting after StopAccept")
	}
}

func TestVisitorUDPQuotaReleased(t *testing.T) {
	echo, echoPort := startEchoUDP(t)
	defer echo.Close()
	s, addr, tlsConf := startTLSGate(t, UDPRequired)
	s.SetToken("tok", "nde1")
	s.PutMappings("nde1", []wire.Mapping{{
		ID: "map_vud", Name: "v", Proto: "udp", Mode: "visitor",
		LocalHost: "127.0.0.1", LocalPort: echoPort,
		Enabled: true, MaxConns: 1, IdleTimeoutSec: 30,
	}})
	ticket := "umbra_vis_udp"
	s.SetTicket(TicketHash(ticket), "map_vud", time.Now().Add(time.Hour))
	go func() { _ = node.Run(addr, "tok", tlsConf) }()
	waitOnline(t, s, "nde1")
	waitUDP(t, s, "nde1")

	ready := make(chan string, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		_ = visit.Run(ctx, visit.Config{
			Server: addr, Ticket: ticket, Local: "127.0.0.1:0", TLS: tlsConf,
			OnListen: func(_, a string) { ready <- a },
		})
	}()
	var local string
	select {
	case local = <-ready:
	case <-time.After(3 * time.Second):
		t.Fatal("visit udp did not listen")
	}
	pc, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	raddr, err := net.ResolveUDPAddr("udp", local)
	if err != nil {
		t.Fatal(err)
	}
	msg := []byte("udp-vis")
	if _, err := pc.WriteToUDP(msg, raddr); err != nil {
		t.Fatal(err)
	}
	_ = pc.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 64)
	n, _, err := pc.ReadFromUDP(buf)
	if err != nil {
		t.Fatal(err)
	}
	if string(buf[:n]) != string(msg) {
		t.Fatalf("got %q", buf[:n])
	}
	deadline := time.Now().Add(time.Second)
	var active int
	for time.Now().Before(deadline) {
		active = s.MappingStats()["map_vud"].Active
		if active == 1 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if active != 1 {
		t.Fatalf("active=%d want 1 (double-reserve leak would be 2)", active)
	}
	cancel()
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if s.MappingStats()["map_vud"].Active == 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("active leaked after session close: %d", s.MappingStats()["map_vud"].Active)
}

func TestPlainModeDoesNotEnableUPlane(t *testing.T) {
	s, addr := startGate(t)
	s.SetToken("tok", "nde1")
	go func() { _ = node.Run(addr, "tok", nil) }()
	waitOnline(t, s, "nde1")
	if s.nodeUDPReady("nde1") {
		t.Fatal("plain connection must not enable uplane")
	}
}

func TestUDPPayloadSizesOverUPlane(t *testing.T) {
	echo, echoPort := startEchoUDP(t)
	defer echo.Close()
	s, addr, tlsConf := startTLSGate(t, UDPRequired)
	s.SetToken("tok", "nde1")
	pub := pickPort(t)
	port := pub
	s.PutMappings("nde1", []wire.Mapping{{
		ID: "map_sz", Name: "u", Proto: "udp", Mode: "public",
		EntryPort: &port, LocalHost: "127.0.0.1", LocalPort: echoPort,
		Enabled: true, MaxConns: 8, IdleTimeoutSec: 30,
	}})
	go func() { _ = node.Run(addr, "tok", tlsConf) }()
	waitOnline(t, s, "nde1")
	waitUDP(t, s, "nde1")
	pc, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	dst := &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: pub}
	for _, n := range []int{1200, 1400} {
		msg := make([]byte, n)
		for i := range msg {
			msg[i] = byte(i)
		}
		if _, err := pc.WriteToUDP(msg, dst); err != nil {
			t.Fatal(err)
		}
		_ = pc.SetReadDeadline(time.Now().Add(2 * time.Second))
		buf := make([]byte, n+16)
		got, _, err := pc.ReadFromUDP(buf)
		if err != nil {
			t.Fatalf("%d: %v", n, err)
		}
		if got != n {
			t.Fatalf("%d got %d", n, got)
		}
	}
	if via := s.MappingStats()["map_sz"].UDPVia; via != "uplane" {
		t.Fatalf("via %q", via)
	}
}

func TestVisitorUDPRejectsForeignMapping(t *testing.T) {
	s := New("127.0.0.1", stealth.New(false))
	s.visits["vis1"] = &visitUDP{id: "vis1", mapID: "map_a", nodeID: "nde1", proto: "udp", mode: "visitor"}
	e := &entry{spec: wire.Mapping{ID: "map_b", Proto: "udp", Mode: "visitor", Enabled: true}, nodeID: "nde1", udpSess: map[string]*udpSess{}}
	s.ent["map_b"] = e
	s.onUDPData("vis1", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 9}, uplane.Packet{
		Type: uplane.TypeData, MappingID: "map_b", FlowID: "flow-x", PeerIP: net.ParseIP("127.0.0.1"), PeerPort: 9, Payload: []byte("x"),
	})
	if len(e.udpSess) != 0 {
		t.Fatal("cross-mapping visitor packet must be dropped")
	}
}

func TestVisitorFlowsDoNotShareSession(t *testing.T) {
	s := New("127.0.0.1", stealth.New(false))
	s.udpMode = UDPRequired
	s.nodes["nde1"] = &nodeConn{id: "nde1", online: true, udpBound: true, udpOut: &uplane.Writer{Key: make([]byte, 32)}, udpAddr: &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 9}}
	s.nodes["nde1"].udpSeen.Store(time.Now().UnixNano())
	s.visits["vis1"] = &visitUDP{id: "vis1", mapID: "map_v", nodeID: "nde1", proto: "udp", mode: "visitor", bound: true}
	s.visits["vis2"] = &visitUDP{id: "vis2", mapID: "map_v", nodeID: "nde1", proto: "udp", mode: "visitor", bound: true}
	e := &entry{spec: wire.Mapping{ID: "map_v", Proto: "udp", Mode: "visitor", Enabled: true, IdleTimeoutSec: 30}, nodeID: "nde1", udpSess: map[string]*udpSess{}}
	e.spec.MaxConns = 8
	s.ent["map_v"] = e
	peer := uplane.Packet{Type: uplane.TypeData, MappingID: "map_v", PeerIP: net.ParseIP("127.0.0.1"), PeerPort: 50000, Payload: []byte("a")}
	p1, p2 := peer, peer
	p1.FlowID, p2.FlowID = "flow-1", "flow-2"
	s.forwardVisitUDP("nde1", "vis1", p1)
	s.forwardVisitUDP("nde1", "vis2", p2)
	if e.udpSess[udpFlowIndex("flow-1")] == nil || e.udpSess[udpFlowIndex("flow-2")] == nil {
		t.Fatal("each visitor flow needs its own session")
	}
	if e.udpSess[udpFlowIndex("flow-1")].visitID == e.udpSess[udpFlowIndex("flow-2")].visitID {
		t.Fatal("visit IDs must not be overwritten")
	}
	if int(e.active.Load()) != 2 {
		t.Fatalf("active=%d want 2", e.active.Load())
	}
}

func TestVisitorCloseRejectsForeignFlow(t *testing.T) {
	s := New("127.0.0.1", stealth.New(false))
	s.udpMode = UDPRequired
	s.nodes["nde1"] = &nodeConn{id: "nde1", online: true, udpBound: true, udpOut: &uplane.Writer{Key: make([]byte, 32)}, udpAddr: &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 9}}
	s.nodes["nde1"].udpSeen.Store(time.Now().UnixNano())
	s.visits["vis1"] = &visitUDP{id: "vis1", mapID: "map_v", nodeID: "nde1", proto: "udp", mode: "visitor", bound: true}
	s.visits["vis2"] = &visitUDP{id: "vis2", mapID: "map_v", nodeID: "nde1", proto: "udp", mode: "visitor", bound: true}
	e := &entry{spec: wire.Mapping{ID: "map_v", Proto: "udp", Mode: "visitor", Enabled: true, IdleTimeoutSec: 30}, nodeID: "nde1", udpSess: map[string]*udpSess{}}
	e.spec.MaxConns = 8
	s.ent["map_v"] = e
	p1 := uplane.Packet{Type: uplane.TypeData, MappingID: "map_v", FlowID: "flow-1", PeerIP: net.ParseIP("127.0.0.1"), PeerPort: 50000, Payload: []byte("a")}
	s.forwardVisitUDP("nde1", "vis1", p1)
	if e.udpSess[udpFlowIndex("flow-1")] == nil || e.udpSess[udpFlowIndex("flow-1")].visitID != "vis1" {
		t.Fatal("vis1 must own flow-1")
	}
	s.onUDPClose("vis2", uplane.Packet{Type: uplane.TypeClose, MappingID: "map_v", FlowID: "flow-1"})
	if sess := e.udpSess[udpFlowIndex("flow-1")]; sess == nil || sess.visitID != "vis1" {
		t.Fatal("vis2 must not close vis1's flow")
	}
	if int(e.active.Load()) != 1 {
		t.Fatalf("active=%d after foreign close, want 1", e.active.Load())
	}
	s.onUDPClose("vis1", uplane.Packet{Type: uplane.TypeClose, MappingID: "map_v", FlowID: "flow-1"})
	if e.udpSess[udpFlowIndex("flow-1")] != nil {
		t.Fatal("owner close must delete the session")
	}
	if int(e.active.Load()) != 0 {
		t.Fatalf("active=%d after owner close, want 0", e.active.Load())
	}
}

func TestUnidirectionalUDPKeepsReadiness(t *testing.T) {
	ttl := 200 * time.Millisecond
	udpReadyTTLNS.Store(int64(ttl))
	node.SetUDPConfirmEvery(50 * time.Millisecond)
	t.Cleanup(func() {
		udpReadyTTLNS.Store(0)
		node.SetUDPConfirmEvery(0)
	})

	sink, got, sinkPort := startSinkUDP(t)
	defer sink.Close()
	s, addr, tlsConf := startTLSGate(t, UDPRequired)
	s.SetToken("tok", "nde1")
	pub := pickPort(t)
	port := pub
	s.PutMappings("nde1", []wire.Mapping{{
		ID: "map_oneway", Name: "u", Proto: "udp", Mode: "public",
		EntryPort: &port, LocalHost: "127.0.0.1", LocalPort: sinkPort,
		Enabled: true, MaxConns: 8, IdleTimeoutSec: 30,
	}})
	go func() { _ = node.Run(addr, "tok", tlsConf) }()
	waitOnline(t, s, "nde1")
	waitUDP(t, s, "nde1")

	pc, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	dst := &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: pub}
	msg := []byte("one-way")
	span := 2*ttl + 100*time.Millisecond
	deadline := time.Now().Add(span)
	sent := 0
	var lostReady atomic.Bool
	for time.Now().Before(deadline) {
		if _, err := pc.WriteToUDP(msg, dst); err != nil {
			t.Fatal(err)
		}
		sent++
		if !s.nodeUDPReady("nde1") {
			lostReady.Store(true)
		}
		time.Sleep(40 * time.Millisecond)
	}
	wait := time.Now().Add(time.Second)
	for time.Now().Before(wait) && got.Load() < int64(sent) {
		time.Sleep(10 * time.Millisecond)
	}
	if lostReady.Load() || !s.nodeUDPReady("nde1") {
		t.Fatal("uplane readiness expired during unidirectional send")
	}
	if n := got.Load(); n < int64(sent) {
		t.Fatalf("silent backend delivered %d/%d; confirm ticker must keep the path ready", n, sent)
	}
	if via := s.MappingStats()["map_oneway"].UDPVia; via != "uplane" {
		t.Fatalf("via %q want uplane", via)
	}
}

func TestBindDoesNotMarkUPlaneReady(t *testing.T) {
	s := New("127.0.0.1", stealth.New(false))
	s.udpMode = UDPRequired
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	s.udpPC = pc
	cookie := []byte("cookie-16-bytes!")
	c2s, s2c := uplane.DerivePair(bytes.Repeat([]byte{1}, 32), cookie)
	ac := &nodeConn{id: "nde1", online: true, udpCookie: cookie, udpIn: &uplane.Opener{Key: c2s}, udpOut: &uplane.Writer{Key: s2c}}
	s.nodes["nde1"] = ac
	addr := &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 40000}
	s.onUDPBind("nde1", addr, uplane.Packet{Type: uplane.TypeBind, Payload: cookie})
	if s.nodeUDPReady("nde1") {
		t.Fatal("bind must not mark uplane ready")
	}
	s.onUDPConfirm("nde1", addr, uplane.Packet{Type: uplane.TypeBindConfirm, Payload: cookie})
	if !s.nodeUDPReady("nde1") {
		t.Fatal("confirm must mark uplane ready")
	}
}

func TestNodeUDPRejectsForeignMapping(t *testing.T) {
	s := New("127.0.0.1", stealth.New(false))
	s.nodes["nde1"] = &nodeConn{id: "nde1", online: true, udpIn: &uplane.Opener{Key: make([]byte, 32)}}
	e := &entry{spec: wire.Mapping{ID: "map_x", Proto: "udp", Mode: "public", Enabled: true}, nodeID: "nde2", udpSess: map[string]*udpSess{}}
	s.ent["map_x"] = e
	s.onUDPData("nde1", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 9}, uplane.Packet{
		Type: uplane.TypeData, MappingID: "map_x", PeerIP: net.ParseIP("10.0.0.1"), PeerPort: 1, Payload: []byte("x"),
	})
	s.onUDPClose("nde1", uplane.Packet{Type: uplane.TypeClose, MappingID: "map_x"})
	if len(e.udpSess) != 0 {
		t.Fatal("node must not touch another node's mapping")
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

func TestMappingAckMarksGeneration(t *testing.T) {
	s, addr := startGate(t)
	s.SetToken("tok", "nde1")
	port := pickPort(t)
	s.PutMappings("nde1", []wire.Mapping{{
		ID: "map_ack", Name: "t", Proto: "tcp", Mode: "public",
		EntryPort: &port, LocalHost: "127.0.0.1", LocalPort: 9,
		Enabled: true, MaxConns: 8, IdleTimeoutSec: 30, Generation: 3,
	}})
	go func() { _ = node.Run(addr, "tok", nil) }()
	waitOnline(t, s, "nde1")
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		st := s.MappingStats()["map_ack"]
		if st.Acked && st.Generation == 3 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	st := s.MappingStats()["map_ack"]
	t.Fatalf("acked=%v gen=%d", st.Acked, st.Generation)
}

func TestTCPIdleTimeoutReleasesQuota(t *testing.T) {
	echo, echoPort := startEchoTCP(t)
	defer echo.Close()
	s, addr := startGate(t)
	s.SetToken("tok", "nde1")
	pub := pickPort(t)
	port := pub
	s.PutMappings("nde1", []wire.Mapping{{
		ID: "map_idle", Name: "t", Proto: "tcp", Mode: "public",
		EntryPort: &port, LocalHost: "127.0.0.1", LocalPort: echoPort,
		Enabled: true, MaxConns: 8, IdleTimeoutSec: 1,
	}})
	go func() { _ = node.Run(addr, "tok", nil) }()
	waitOnline(t, s, "nde1")
	c, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", itoa(pub)), 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if s.MappingStats()["map_idle"].Active == 0 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("active=%d after idle timeout", s.MappingStats()["map_idle"].Active)
}

func TestVisitorReconnectKeepsLocalPort(t *testing.T) {
	echo, echoPort := startEchoTCP(t)
	defer echo.Close()
	s, addr := startGate(t)
	s.SetToken("tok", "nde1")
	s.PutMappings("nde1", []wire.Mapping{{
		ID: "map_re", Name: "v", Proto: "tcp", Mode: "visitor",
		LocalHost: "127.0.0.1", LocalPort: echoPort,
		Enabled: true, MaxConns: 8, IdleTimeoutSec: 30,
	}})
	ticket := "umbra_vis_re"
	s.SetTicket(TicketHash(ticket), "map_re", time.Now().Add(time.Hour))
	go func() { _ = node.Run(addr, "tok", nil) }()
	waitOnline(t, s, "nde1")
	ready := make(chan string, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		_ = visit.Run(ctx, visit.Config{
			Server: addr, Ticket: ticket, Local: "127.0.0.1:0",
			OnListen: func(_, a string) { ready <- a },
		})
	}()
	var local string
	select {
	case local = <-ready:
	case <-time.After(3 * time.Second):
		t.Fatal("visit did not listen")
	}
	round := func() {
		t.Helper()
		c, err := net.DialTimeout("tcp", local, 2*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		msg := []byte("re-hi")
		if _, err := c.Write(msg); err != nil {
			t.Fatal(err)
		}
		buf := make([]byte, len(msg))
		_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
		if _, err := io.ReadFull(c, buf); err != nil {
			t.Fatal(err)
		}
		if string(buf) != string(msg) {
			t.Fatalf("got %q", buf)
		}
	}
	round()
	s.mu.Lock()
	for _, v := range s.visits {
		if v.mux != nil {
			_ = v.mux.Close()
		}
	}
	s.mu.Unlock()
	deadline := time.Now().Add(4 * time.Second)
	var last error
	for time.Now().Before(deadline) {
		c, err := net.DialTimeout("tcp", local, 400*time.Millisecond)
		if err != nil {
			last = err
			time.Sleep(80 * time.Millisecond)
			continue
		}
		msg := []byte("re-hi")
		_, err = c.Write(msg)
		if err != nil {
			_ = c.Close()
			last = err
			time.Sleep(80 * time.Millisecond)
			continue
		}
		buf := make([]byte, len(msg))
		_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
		_, err = io.ReadFull(c, buf)
		_ = c.Close()
		if err == nil && string(buf) == string(msg) {
			return
		}
		last = err
		time.Sleep(80 * time.Millisecond)
	}
	t.Fatalf("visitor did not recover on same port: %v", last)
}

func TestRotateTokenGraceThenExpires(t *testing.T) {
	s, addr := startGate(t)
	oldTok, newTok := "tok-old", "tok-new"
	s.SetToken(oldTok, "nde1")
	done := make(chan error, 1)
	go func() { done <- node.Run(addr, oldTok, nil) }()
	waitOnline(t, s, "nde1")
	s.RotateToken("nde1", TicketHash(oldTok), TicketHash(newTok), 200*time.Millisecond)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("rotate must disconnect current session")
	}
	if s.LookupToken(oldTok) != "nde1" || s.LookupToken(newTok) != "nde1" {
		t.Fatal("both hashes must work during grace")
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if s.LookupToken(oldTok) == "" {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
	if s.LookupToken(oldTok) != "" {
		t.Fatal("old token must expire after grace")
	}
	if s.LookupToken(newTok) != "nde1" {
		t.Fatal("new token must remain")
	}
	go func() { _ = node.Run(addr, newTok, nil) }()
	waitOnline(t, s, "nde1")
}

func TestEnrollIgnoresBootstrapBody(t *testing.T) {
	s, addr := startGate(t)
	s.SetToken("tok-a", "nde_a")
	s.SetToken("tok-b", "nde_b")
	raw, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	if err := preface.Write(raw, preface.KindNode, "tok-a"); err != nil {
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
	if err := wc.SendJSON("Enroll", map[string]string{
		"bootstrap": "tok-b", "hostname": "x", "os": "linux", "arch": "amd64",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := wc.Read(); err != nil {
		t.Fatal(err)
	}
	if err := wc.SendJSON("Hello", map[string]string{"node_id": "nde_b", "version": "test"}); err != nil {
		t.Fatal(err)
	}
	waitOnline(t, s, "nde_a")
	for _, n := range s.Status().Nodes {
		if n.ID == "nde_b" && n.Online {
			t.Fatal("enroll body bootstrap must not override preface identity")
		}
	}
}

func echoTCP(t *testing.T, addr string, msg string, wait time.Duration) bool {
	t.Helper()
	c, err := net.DialTimeout("tcp", addr, wait)
	if err != nil {
		return false
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(wait))
	if _, err := c.Write([]byte(msg)); err != nil {
		return false
	}
	buf := make([]byte, len(msg))
	if _, err := io.ReadFull(c, buf); err != nil {
		return false
	}
	return string(buf) == msg
}

func TestSPAGrantBindsSourceIP(t *testing.T) {
	echo, echoPort := startEchoTCP(t)
	defer echo.Close()
	s, addr := startGate(t)
	s.SetToken("tok", "nde1")
	pub := pickPort(t)
	port := pub
	s.PutMappings("nde1", []wire.Mapping{{
		ID: "map_spa", Name: "t", Proto: "tcp", Mode: "spa",
		EntryPort: &port, LocalHost: "127.0.0.1", LocalPort: echoPort,
		Enabled: true, MaxConns: 8, SpaTTLSec: 30,
	}})
	go func() { _ = node.Run(addr, "tok", nil) }()
	waitOnline(t, s, "nde1")
	dst := net.JoinHostPort("127.0.0.1", itoa(pub))
	if echoTCP(t, dst, "no", 300*time.Millisecond) {
		t.Fatal("expected drop before knock")
	}
	s.Knock("map_spa", "8.8.8.8", time.Second)
	if echoTCP(t, dst, "other", 300*time.Millisecond) {
		t.Fatal("other IP grant must not admit 127.0.0.1")
	}
	s.Knock("map_spa", "127.0.0.1", time.Second)
	if !echoTCP(t, dst, "ok", 2*time.Second) {
		t.Fatal("knocker IP should be admitted")
	}
}

func TestSPATCPSurvivesGrantExpiry(t *testing.T) {
	echo, echoPort := startEchoTCP(t)
	defer echo.Close()
	s, addr := startGate(t)
	s.SetToken("tok", "nde1")
	pub := pickPort(t)
	port := pub
	s.PutMappings("nde1", []wire.Mapping{{
		ID: "map_keep", Name: "t", Proto: "tcp", Mode: "spa",
		EntryPort: &port, LocalHost: "127.0.0.1", LocalPort: echoPort,
		Enabled: true, MaxConns: 8, IdleTimeoutSec: 0, SpaTTLSec: 1,
	}})
	go func() { _ = node.Run(addr, "tok", nil) }()
	waitOnline(t, s, "nde1")
	s.Knock("map_keep", "127.0.0.1", 200*time.Millisecond)
	dst := net.JoinHostPort("127.0.0.1", itoa(pub))
	c, err := net.DialTimeout("tcp", dst, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err := c.Write([]byte("keep")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 4)
	if _, err := io.ReadFull(c, buf); err != nil {
		t.Fatal(err)
	}
	time.Sleep(350 * time.Millisecond)
	if s.granted("map_keep", "127.0.0.1") {
		t.Fatal("grant should have expired")
	}
	_ = c.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err := c.Write([]byte("still")); err != nil {
		t.Fatal(err)
	}
	buf = make([]byte, 5)
	if _, err := io.ReadFull(c, buf); err != nil {
		t.Fatalf("existing TCP should survive grant expiry: %v", err)
	}
	if echoTCP(t, dst, "new", 300*time.Millisecond) {
		t.Fatal("new TCP after expiry must be dropped")
	}
}

func TestSPAUDPIdleIndependentOfGrant(t *testing.T) {
	echo, echoPort := startEchoUDP(t)
	defer echo.Close()
	s, addr := startGate(t)
	s.SetToken("tok", "nde1")
	pub := pickPort(t)
	port := pub
	s.PutMappings("nde1", []wire.Mapping{{
		ID: "map_udle", Name: "u", Proto: "udp", Mode: "spa",
		EntryPort: &port, LocalHost: "127.0.0.1", LocalPort: echoPort,
		Enabled: true, MaxConns: 8, UdpIdleTimeoutSec: 2, SpaTTLSec: 1,
	}})
	go func() { _ = node.Run(addr, "tok", nil) }()
	waitOnline(t, s, "nde1")
	s.Knock("map_udle", "127.0.0.1", 250*time.Millisecond)
	pc, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	dst := &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: pub}
	msg := []byte("u1")
	if _, err := pc.WriteToUDP(msg, dst); err != nil {
		t.Fatal(err)
	}
	_ = pc.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 8)
	n, _, err := pc.ReadFromUDP(buf)
	if err != nil || string(buf[:n]) != "u1" {
		t.Fatalf("first udp %v %q", err, buf[:n])
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && s.granted("map_udle", "127.0.0.1") {
		time.Sleep(20 * time.Millisecond)
	}
	if s.granted("map_udle", "127.0.0.1") {
		t.Fatal("grant should have expired")
	}
	if _, err := pc.WriteToUDP([]byte("u2"), dst); err != nil {
		t.Fatal(err)
	}
	_ = pc.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, _, err = pc.ReadFromUDP(buf)
	if err != nil || string(buf[:n]) != "u2" {
		t.Fatalf("existing udp session should survive grant expiry: %v %q", err, buf[:n])
	}
	fresh, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer fresh.Close()
	if _, err := fresh.WriteToUDP([]byte("u3"), dst); err != nil {
		t.Fatal(err)
	}
	_ = fresh.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	if n, _, err := fresh.ReadFromUDP(buf); err == nil {
		t.Fatalf("new udp session after expiry must drop, got %q", buf[:n])
	}
}
