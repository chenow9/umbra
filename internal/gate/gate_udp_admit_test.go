package gate

import (
	"net"
	"testing"
	"time"

	"umbra/internal/node"
	"umbra/internal/wire"
)

func startUDPPublic(t *testing.T, maxConns, idleSec int) (*Server, int) {
	t.Helper()
	echo, echoPort := startEchoUDP(t)
	t.Cleanup(func() { echo.Close() })
	s, addr, tlsConf := startTLSGate(t, UDPRequired)
	s.SetToken("tok", "nde1")
	pub := pickPort(t)
	port := pub
	s.PutMappings("nde1", []wire.Mapping{{
		ID: "map_udp", Name: "u", Proto: "udp", Mode: "public",
		EntryPort: &port, LocalHost: "127.0.0.1", LocalPort: echoPort,
		Enabled: true, MaxConns: maxConns, IdleTimeoutSec: idleSec,
	}})
	go func() { _ = node.Run(addr, "tok", tlsConf) }()
	waitOnline(t, s, "nde1")
	waitUDP(t, s, "nde1")
	return s, pub
}

func listenUDPIP(t *testing.T, ip string) *net.UDPConn {
	t.Helper()
	pc, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP(ip), Port: 0})
	if err != nil {
		t.Skipf("cannot bind UDP %s: %v", ip, err)
	}
	t.Cleanup(func() { pc.Close() })
	return pc
}

func udpEchoOK(t *testing.T, pc *net.UDPConn, dst *net.UDPAddr, msg []byte, wait time.Duration) bool {
	t.Helper()
	if _, err := pc.WriteToUDP(msg, dst); err != nil {
		t.Fatal(err)
	}
	_ = pc.SetReadDeadline(time.Now().Add(wait))
	buf := make([]byte, 2048)
	n, _, err := pc.ReadFromUDP(buf)
	if err != nil {
		return false
	}
	return string(buf[:n]) == string(msg)
}

func waitUDPActive(t *testing.T, s *Server, id string, want int, d time.Duration) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		st := s.MappingStats()[id]
		if st.UDPActive == want && st.Active == want {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	st := s.MappingStats()[id]
	t.Fatalf("udp_active=%d active=%d want %d", st.UDPActive, st.Active, want)
}

func TestUDPAdmitPerIPDoesNotBlockOtherIP(t *testing.T) {
	defer SetUDPAdmitForTest(1, 0)()
	e := &entry{spec: wire.Mapping{MaxConns: 8}, udpIP: map[string]*udpIPState{}}
	if reason := e.admitUDP("10.0.0.1"); reason != "" {
		t.Fatalf("first flow: %s", reason)
	}
	if reason := e.admitUDP("10.0.0.1"); reason != udpDropReasonPerIP {
		t.Fatalf("same IP over cap: %s", reason)
	}
	if e.udpDropPerIP.Load() < 1 {
		t.Fatal("udp_drop_perip not counted")
	}
	if e.udpDropMaxConns.Load() != 0 {
		t.Fatal("per-IP overflow must not increment maxconns drops")
	}
	if reason := e.admitUDP("10.0.0.2"); reason != "" {
		t.Fatalf("other IP blocked: %s", reason)
	}
	if int(e.active.Load()) != 2 {
		t.Fatalf("active=%d want 2", e.active.Load())
	}
	e.releaseUDP("10.0.0.1")
	if reason := e.admitUDP("10.0.0.1"); reason != "" {
		t.Fatalf("after release same IP should admit: %s", reason)
	}
}

func TestUDPAdmitMaxConnsReason(t *testing.T) {
	defer SetUDPAdmitForTest(8, 0)()
	e := &entry{spec: wire.Mapping{MaxConns: 1}, udpIP: map[string]*udpIPState{}}
	if reason := e.admitUDP("10.0.0.1"); reason != "" {
		t.Fatalf("first: %s", reason)
	}
	if reason := e.admitUDP("10.0.0.2"); reason != udpDropReasonMaxConns {
		t.Fatalf("global full: %s", reason)
	}
	if e.udpDropMaxConns.Load() < 1 {
		t.Fatal("udp_drop_maxconns not counted")
	}
	if n := len(e.udpIP); n != 1 {
		t.Fatalf("failed admit published IP state: len=%d", n)
	}
}

func TestUDPAdmitMaxConnsDoesNotGrowIPMap(t *testing.T) {
	defer SetUDPAdmitForTest(0, 0)()
	e := &entry{spec: wire.Mapping{MaxConns: 1}, udpIP: map[string]*udpIPState{}}
	if reason := e.admitUDP("10.0.0.1"); reason != "" {
		t.Fatalf("hold: %s", reason)
	}
	const n = 100000
	for i := 0; i < n; i++ {
		ip := "11." + itoa((i>>16)&0xff) + "." + itoa((i>>8)&0xff) + "." + itoa(i&0xff)
		if reason := e.admitUDP(ip); reason != udpDropReasonMaxConns {
			t.Fatalf("i=%d reason=%s", i, reason)
		}
	}
	if got := len(e.udpIP); got != 1 {
		t.Fatalf("udpIP grew to %d after %d maxconns drops", got, n)
	}
	if e.udpDropMaxConns.Load() != n {
		t.Fatalf("drops=%d want %d", e.udpDropMaxConns.Load(), n)
	}
}

func TestUDPAdmitIPv6AggregatesTo64(t *testing.T) {
	defer SetUDPAdmitForTest(1, 0)()
	e := &entry{spec: wire.Mapping{MaxConns: 8}, udpIP: map[string]*udpIPState{}}
	if reason := e.admitUDP("2001:db8:1::1"); reason != "" {
		t.Fatalf("first: %s", reason)
	}
	if reason := e.admitUDP("2001:db8:1::2"); reason != udpDropReasonPerIP {
		t.Fatalf("same /64: %s", reason)
	}
	if reason := e.admitUDP("2001:db8:2::1"); reason != "" {
		t.Fatalf("other /64 blocked: %s", reason)
	}
	if len(e.udpIP) != 2 {
		t.Fatalf("udpIP=%d want 2 prefixes", len(e.udpIP))
	}
}

func TestUDPAdmitMapRate(t *testing.T) {
	defer SetUDPAdmitLimitsForTest(8, 0, 1)()
	e := &entry{spec: wire.Mapping{MaxConns: 8}, udpIP: map[string]*udpIPState{}}
	if reason := e.admitUDP("10.0.0.1"); reason != "" {
		t.Fatalf("first: %s", reason)
	}
	if reason := e.admitUDP("10.0.0.2"); reason != udpDropReasonRate {
		t.Fatalf("map rate: %s", reason)
	}
	if len(e.udpIP) != 1 {
		t.Fatalf("rate drop published IP: %d", len(e.udpIP))
	}
}

func TestUDPDropLogRateLimited(t *testing.T) {
	e := &entry{spec: wire.Mapping{ID: "map_log"}}
	if !e.udpLogOK(udpDropReasonMaxConns) {
		t.Fatal("first maxconns log")
	}
	if e.udpLogOK(udpDropReasonMaxConns) {
		t.Fatal("second maxconns log in the same second")
	}
	if !e.udpLogOK(udpDropReasonPerIP) {
		t.Fatal("per_ip is a different reason")
	}
}

func TestUDPReleaseRefillsTokensAfterIdle(t *testing.T) {
	defer SetUDPAdmitForTest(8, 1)()
	e := &entry{spec: wire.Mapping{MaxConns: 8}, udpIP: map[string]*udpIPState{}}
	if reason := e.admitUDP("10.0.0.1"); reason != "" {
		t.Fatalf("first: %s", reason)
	}
	st := e.udpIP[udpAdmitKey("10.0.0.1")]
	if st == nil {
		t.Fatal("missing IP state")
	}
	st.tokens = 0
	st.last = time.Now().Add(-2 * time.Second)
	e.releaseUDP("10.0.0.1")
	if reason := e.admitUDP("10.0.0.1"); reason != "" {
		t.Fatalf("after 2s live flow, release must refill token: %s", reason)
	}
}

func TestUDPPerIPRateSurvivesLastRelease(t *testing.T) {
	defer SetUDPAdmitForTest(8, 1)()
	e := &entry{spec: wire.Mapping{MaxConns: 1000}, udpIP: map[string]*udpIPState{}}
	ok := 0
	for i := 0; i < 1000; i++ {
		reason := e.admitUDP("10.0.0.1")
		switch reason {
		case "":
			ok++
			e.releaseUDP("10.0.0.1")
		case udpDropReasonRate:
			if len(e.udpIP) != 1 {
				t.Fatalf("rate drop must keep IP token state, len=%d i=%d", len(e.udpIP), i)
			}
		default:
			t.Fatalf("i=%d reason=%s", i, reason)
		}
	}
	if ok != 1 {
		t.Fatalf("admit/release churn succeeded %d times, want 1 (token bucket reset on last release)", ok)
	}
	st := e.udpIP[udpAdmitKey("10.0.0.1")]
	if st == nil || st.n != 0 {
		t.Fatalf("empty IP state should be kept for TTL, st=%v", st)
	}
}

func TestUDPAdmitRateIsolatesIP(t *testing.T) {
	defer SetUDPAdmitForTest(8, 1)()
	e := &entry{spec: wire.Mapping{MaxConns: 8}, udpIP: map[string]*udpIPState{}}
	if reason := e.admitUDP("10.0.0.1"); reason != "" {
		t.Fatalf("first: %s", reason)
	}
	if reason := e.admitUDP("10.0.0.1"); reason != udpDropReasonRate {
		t.Fatalf("rate: %s", reason)
	}
	if e.udpDropRate.Load() < 1 {
		t.Fatal("udp_drop_rate not counted")
	}
	if reason := e.admitUDP("10.0.0.2"); reason != "" {
		t.Fatalf("other IP shares rate bucket: %s", reason)
	}
}

func TestUDPPerIPCapDropsSameIP(t *testing.T) {
	defer SetUDPAdmitForTest(1, 0)()
	s, pub := startUDPPublic(t, 8, 30)
	dst := &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: pub}
	a1 := listenUDPIP(t, "127.0.0.1")
	a2 := listenUDPIP(t, "127.0.0.1")
	if !udpEchoOK(t, a1, dst, []byte("ip1-ok"), time.Second) {
		t.Fatal("first flow should forward")
	}
	waitUDPActive(t, s, "map_udp", 1, time.Second)
	if udpEchoOK(t, a2, dst, []byte("ip1-over"), 250*time.Millisecond) {
		t.Fatal("second flow from same IP should be dropped")
	}
	st := s.MappingStats()["map_udp"]
	if st.UDPDropPerIP < 1 {
		t.Fatalf("want udp_drop_perip>=1 got %+v", st)
	}
	if st.UDPDropMaxConns != 0 {
		t.Fatalf("same-IP overflow must not consume maxconns: %+v", st)
	}
}

func TestUDPPerIPCapDoesNotBlockOtherIP(t *testing.T) {
	b := listenUDPIP(t, "127.0.0.2")
	defer SetUDPAdmitForTest(1, 0)()
	s, pub := startUDPPublic(t, 8, 30)
	dst := &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: pub}
	a1 := listenUDPIP(t, "127.0.0.1")
	a2 := listenUDPIP(t, "127.0.0.1")

	if !udpEchoOK(t, a1, dst, []byte("ip1-ok"), time.Second) {
		t.Fatal("first flow from 127.0.0.1 should forward")
	}
	waitUDPActive(t, s, "map_udp", 1, time.Second)
	if udpEchoOK(t, a2, dst, []byte("ip1-over"), 250*time.Millisecond) {
		t.Fatal("second flow from same IP should be dropped")
	}
	st := s.MappingStats()["map_udp"]
	if st.UDPDropPerIP < 1 {
		t.Fatalf("want udp_drop_perip>=1 got %+v", st)
	}
	if st.UDPDropMaxConns != 0 {
		t.Fatalf("same-IP overflow must not consume maxconns: %+v", st)
	}
	if !udpEchoOK(t, b, dst, []byte("ip2-ok"), time.Second) {
		t.Fatal("other IP must still forward while one IP is over quota")
	}
	waitUDPActive(t, s, "map_udp", 2, time.Second)
}

func TestUDPMaxConnsDropReason(t *testing.T) {
	defer SetUDPAdmitForTest(8, 0)()
	s, pub := startUDPPublic(t, 1, 30)
	dst := &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: pub}
	a := listenUDPIP(t, "127.0.0.1")
	b := listenUDPIP(t, "127.0.0.1")
	if !udpEchoOK(t, a, dst, []byte("hold"), time.Second) {
		t.Fatal("first flow should occupy MaxConns")
	}
	waitUDPActive(t, s, "map_udp", 1, time.Second)
	if udpEchoOK(t, b, dst, []byte("blocked"), 250*time.Millisecond) {
		t.Fatal("MaxConns full should drop the extra flow")
	}
	st := s.MappingStats()["map_udp"]
	if st.UDPDropMaxConns < 1 {
		t.Fatalf("want udp_drop_maxconns>=1 got %+v", st)
	}
	if s.Status().UDPDropMaxConns < 1 {
		t.Fatalf("status udpDropMaxConns=%d", s.Status().UDPDropMaxConns)
	}
	if st.UDPActive != 1 {
		t.Fatalf("udp_active=%d want 1", st.UDPActive)
	}
}

func TestUDPExpireNotifiesNodeClose(t *testing.T) {
	e := &entry{udpSess: map[string]*udpSess{}}
	e.active.Store(1)
	called := make(chan struct{}, 1)
	sess := &udpSess{idle: 20 * time.Millisecond, closer: func() { called <- struct{}{} }}
	e.udpSess["k"] = sess
	e.mu.Lock()
	sess.touchLocked(e, "k")
	e.mu.Unlock()
	select {
	case <-called:
	case <-time.After(time.Second):
		t.Fatal("idle expire should send TypeClose to the node")
	}
	if e.active.Load() != 0 {
		t.Fatalf("active=%d after expire", e.active.Load())
	}
}

func TestUDPIdleTimeoutReleasesActive(t *testing.T) {
	defer SetUDPAdmitForTest(8, 0)()
	s, pub := startUDPPublic(t, 8, 1)
	dst := &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: pub}
	pc := listenUDPIP(t, "127.0.0.1")
	if !udpEchoOK(t, pc, dst, []byte("idle"), time.Second) {
		t.Fatal("udp echo")
	}
	waitUDPActive(t, s, "map_udp", 1, time.Second)
	waitUDPActive(t, s, "map_udp", 0, 3*time.Second)
	if s.Status().UDPActive != 0 {
		t.Fatalf("status udpActive=%d after idle", s.Status().UDPActive)
	}
	if !udpEchoOK(t, pc, dst, []byte("after-idle"), time.Second) {
		t.Fatal("new flow after idle should forward")
	}
}
