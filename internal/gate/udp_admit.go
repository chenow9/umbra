package gate

import (
	"log/slog"
	"net"
	"os"
	"strconv"
	"sync/atomic"
	"time"

	"umbra/internal/policy"
)

// UDP public-mapping admission. MaxConns remains the mapping-global ceiling;
// per-IP (IPv6: /64) and new-flow rate limits stop a single client from
// occupying the whole quota for the idle window.
const (
	defaultUDPMaxFlowsPerIP  = 256
	defaultUDPNewFlowsPerSec = 256
	defaultUDPNewFlowsPerMap = 1024
	defaultUDPIPMapMax       = 4096
	udpIPIdleTTL             = 2 * time.Second
	udpIPSweepInterval       = time.Second
	udpDropLogInterval       = time.Second

	udpDropReasonMaxConns = "maxconns"
	udpDropReasonPerIP    = "per_ip"
	udpDropReasonRate     = "rate"
)

var (
	udpMaxFlowsPerIP  atomic.Int32
	udpNewFlowsPerSec atomic.Int32
	udpNewFlowsPerMap atomic.Int32
	udpIPMapMax       atomic.Int32
)

func init() {
	udpMaxFlowsPerIP.Store(defaultUDPMaxFlowsPerIP)
	udpNewFlowsPerSec.Store(defaultUDPNewFlowsPerSec)
	udpNewFlowsPerMap.Store(defaultUDPNewFlowsPerMap)
	udpIPMapMax.Store(defaultUDPIPMapMax)
	if v := os.Getenv("UMBRA_UDP_MAX_FLOWS_PER_IP"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			udpMaxFlowsPerIP.Store(int32(n))
		}
	}
	if v := os.Getenv("UMBRA_UDP_NEW_FLOWS_PER_SEC"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			udpNewFlowsPerSec.Store(int32(n))
		}
	}
	if v := os.Getenv("UMBRA_UDP_NEW_FLOWS_PER_MAP"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			udpNewFlowsPerMap.Store(int32(n))
		}
	}
}

type udpIPState struct {
	n      int
	tokens float64
	last   time.Time
}

func UDPAdmitLimits() (perIP, perSec, perMap int) {
	return int(udpMaxFlowsPerIP.Load()), int(udpNewFlowsPerSec.Load()), int(udpNewFlowsPerMap.Load())
}

// SetUDPAdmitForTest overrides per-IP and per-IP new-flow/sec limits.
// Mapping-global new-flow rate is disabled (0) so tests stay isolated.
func SetUDPAdmitForTest(perIP, perSec int) func() {
	return setUDPAdmitLimits(perIP, perSec, 0)
}

func SetUDPAdmitLimitsForTest(perIP, perSec, perMap int) func() {
	return setUDPAdmitLimits(perIP, perSec, perMap)
}

func setUDPAdmitLimits(perIP, perSec, perMap int) func() {
	oldIP, oldSec, oldMap := udpMaxFlowsPerIP.Load(), udpNewFlowsPerSec.Load(), udpNewFlowsPerMap.Load()
	udpMaxFlowsPerIP.Store(int32(perIP))
	udpNewFlowsPerSec.Store(int32(perSec))
	udpNewFlowsPerMap.Store(int32(perMap))
	return func() {
		udpMaxFlowsPerIP.Store(oldIP)
		udpNewFlowsPerSec.Store(oldSec)
		udpNewFlowsPerMap.Store(oldMap)
	}
}

// udpAdmitKey is the quota identity: IPv4 as-is, IPv6 aggregated to /64.
func udpAdmitKey(ip string) string {
	if ip == "" {
		return "unknown"
	}
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return ip
	}
	if v4 := parsed.To4(); v4 != nil {
		return v4.String()
	}
	v6 := parsed.To16()
	if v6 == nil {
		return ip
	}
	masked := make(net.IP, net.IPv6len)
	copy(masked, v6)
	for i := 8; i < net.IPv6len; i++ {
		masked[i] = 0
	}
	return masked.String() + "/64"
}

func (st *udpIPState) refill(rate float64, now time.Time) {
	if rate > 0 && !st.last.IsZero() {
		if dt := now.Sub(st.last).Seconds(); dt > 0 {
			st.tokens += dt * rate
			if st.tokens > rate {
				st.tokens = rate
			}
		}
	}
	st.last = now
}

// admitUDP must run with e.mu held. Empty reason means the new flow is reserved.
// Unknown IPs are inserted only after reserve() succeeds; every failure path
// leaves udpIP unchanged and does not scan the map.
func (e *entry) admitUDP(ip string) string {
	key := udpAdmitKey(ip)
	if e.udpIP == nil {
		e.udpIP = map[string]*udpIPState{}
	}

	perIP := int(udpMaxFlowsPerIP.Load())
	ipRate := float64(udpNewFlowsPerSec.Load())
	mapRate := float64(udpNewFlowsPerMap.Load())
	now := time.Now()

	st := e.udpIP[key]
	n := 0
	tokens := ipRate
	if st != nil {
		st.refill(ipRate, now)
		n = st.n
		tokens = st.tokens
	}

	if ipRate > 0 && tokens < 1 {
		e.udpDropRate.Add(1)
		return udpDropReasonRate
	}
	if perIP > 0 && n >= perIP {
		e.udpDropPerIP.Add(1)
		return udpDropReasonPerIP
	}

	if mapRate > 0 {
		if e.udpMapLast.IsZero() {
			e.udpMapTokens = mapRate
		} else if dt := now.Sub(e.udpMapLast).Seconds(); dt > 0 {
			e.udpMapTokens += dt * mapRate
			if e.udpMapTokens > mapRate {
				e.udpMapTokens = mapRate
			}
		}
		e.udpMapLast = now
		if e.udpMapTokens < 1 {
			e.udpDropRate.Add(1)
			return udpDropReasonRate
		}
	}

	if !e.reserve() {
		e.udpDropMaxConns.Add(1)
		return udpDropReasonMaxConns
	}

	if st == nil {
		e.ensureUDPIPRoomLocked(now)
		st = &udpIPState{last: now}
		if ipRate > 0 {
			st.tokens = ipRate
		}
		e.udpIP[key] = st
	}
	st.n = n + 1
	st.last = now
	if ipRate > 0 {
		st.tokens = tokens - 1
	}
	if mapRate > 0 {
		e.udpMapTokens -= 1
	}
	if st.n > 1 || len(e.udpIP) > 1 {
		e.maybeSweepUDPIPLocked(now)
	}
	return ""
}

func (e *entry) releaseUDP(ip string) {
	e.release()
	if e.udpIP == nil {
		return
	}
	key := udpAdmitKey(ip)
	st := e.udpIP[key]
	if st == nil {
		return
	}
	now := time.Now()
	st.refill(float64(udpNewFlowsPerSec.Load()), now)
	st.n--
	if st.n < 0 {
		st.n = 0
	}
	e.maybeSweepUDPIPLocked(now)
	// Keep n==0 so the token bucket survives churn. TTL/LRU evicts idle
	// empty entries; failed admits still must not insert.
}

func (e *entry) dropUDPSessLocked(sess *udpSess) {
	if sess == nil {
		return
	}
	e.delUDPSess(sess)
	e.releaseUDP(sess.admitIP)
	if sess.timer != nil {
		sess.timer.Stop()
	}
}

func (e *entry) udpIPLimit() int {
	max := int(udpIPMapMax.Load())
	if max <= 0 {
		max = defaultUDPIPMapMax
	}
	if n := policy.IntOr(e.spec.MaxConns, 64) * 2; n > max {
		max = n
	}
	return max
}

func (e *entry) sweepIdleUDPIPLocked(now time.Time) {
	for k, st := range e.udpIP {
		if st.n <= 0 && now.Sub(st.last) >= udpIPIdleTTL {
			delete(e.udpIP, k)
		}
	}
}

func (e *entry) maybeSweepUDPIPLocked(now time.Time) {
	ns := now.UnixNano()
	last := e.udpIPSweepNS.Load()
	if last != 0 && ns-last < int64(udpIPSweepInterval) {
		return
	}
	e.udpIPSweepNS.Store(ns)
	e.sweepIdleUDPIPLocked(now)
}

func (e *entry) evictOldestIdleUDPIPLocked() bool {
	var oldest string
	var oldestT time.Time
	found := false
	for k, st := range e.udpIP {
		if st.n > 0 {
			continue
		}
		if !found || st.last.Before(oldestT) {
			oldest, oldestT, found = k, st.last, true
		}
	}
	if !found {
		return false
	}
	delete(e.udpIP, oldest)
	return true
}

func (e *entry) ensureUDPIPRoomLocked(now time.Time) {
	max := e.udpIPLimit()
	if len(e.udpIP) < max {
		e.maybeSweepUDPIPLocked(now)
		return
	}
	e.sweepIdleUDPIPLocked(now)
	for len(e.udpIP) >= max && e.evictOldestIdleUDPIPLocked() {
	}
}

func (e *entry) noteUDPDrop(ip, reason string) {
	if !e.udpLogOK(reason) {
		return
	}
	slog.Info("udp drop", "mapping", e.spec.ID, "ip", ip, "reason", reason)
}

func (e *entry) udpLogOK(reason string) bool {
	var slot *atomic.Int64
	switch reason {
	case udpDropReasonPerIP:
		slot = &e.udpLogNSPerIP
	case udpDropReasonRate:
		slot = &e.udpLogNSRate
	default:
		slot = &e.udpLogNSMaxConns
	}
	now := time.Now().UnixNano()
	last := slot.Load()
	if last != 0 && now-last < int64(udpDropLogInterval) {
		return false
	}
	return slot.CompareAndSwap(last, now)
}
