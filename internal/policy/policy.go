package policy

import (
	"net"
	"net/netip"
	"strconv"
	"strings"
	"time"
)

func NormalizeIP(addr string) string {
	if host, _, err := net.SplitHostPort(addr); err == nil {
		addr = host
	}
	ip := net.ParseIP(addr)
	if ip == nil {
		return addr
	}
	if v4 := ip.To4(); v4 != nil {
		return v4.String()
	}
	return ip.String()
}

// ACL is a pre-parsed source allow list. The zero value (or an empty
// string) allows every source; a non-empty list with only unparsable
// entries allows nothing. Parse once per configuration change and call
// Allows on the hot path instead of re-parsing CIDR text per packet.
type ACL struct {
	nets   []netip.Prefix
	strict bool
}

func ParseACL(cidrs string) ACL {
	list := strings.FieldsFunc(cidrs, func(r rune) bool { return r == ',' || r == ' ' || r == '\n' })
	if len(list) == 0 {
		return ACL{}
	}
	a := ACL{strict: true, nets: make([]netip.Prefix, 0, len(list))}
	for _, raw := range list {
		if !strings.Contains(raw, "/") {
			addr, err := netip.ParseAddr(raw)
			if err != nil {
				continue
			}
			addr = addr.Unmap()
			a.nets = append(a.nets, netip.PrefixFrom(addr, addr.BitLen()))
			continue
		}
		p, err := netip.ParsePrefix(raw)
		if err != nil {
			continue
		}
		if p.Addr().Is4In6() {
			p = netip.PrefixFrom(p.Addr().Unmap(), max(0, p.Bits()-96))
		}
		a.nets = append(a.nets, p.Masked())
	}
	return a
}

// Empty reports whether the ACL admits every source.
func (a ACL) Empty() bool { return !a.strict }

func (a ACL) Allows(ip string) bool {
	if !a.strict {
		return true
	}
	addr, err := netip.ParseAddr(NormalizeIP(ip))
	if err != nil {
		return false
	}
	addr = addr.Unmap()
	for _, p := range a.nets {
		if p.Contains(addr) {
			return true
		}
	}
	return false
}

// CidrAllowed is the one-shot form of ParseACL(cidrs).Allows(ip) for
// callers that evaluate a list rarely.
func CidrAllowed(ip string, cidrs string) bool {
	return ParseACL(cidrs).Allows(ip)
}

// Limiter is a token bucket shaping a mapping to rateKbps KiB/s. The bucket
// holds one second of traffic so short bursts pass without delay; sustained
// traffic is smoothed instead of being cut off at a fixed window boundary.
type Limiter struct {
	tokens float64
	last   time.Time
	nowFn  func() time.Time
}

func (l *Limiter) now() time.Time {
	if l.nowFn != nil {
		return l.nowFn()
	}
	return time.Now()
}

func (l *Limiter) refill(rate float64) {
	now := l.now()
	if l.last.IsZero() {
		l.tokens = rate
		l.last = now
		return
	}
	if dt := now.Sub(l.last).Seconds(); dt > 0 {
		l.tokens += dt * rate
		if l.tokens > rate {
			l.tokens = rate
		}
	}
	l.last = now
}

// Take reports whether n bytes fit right now and debits them if so. Callers
// that cannot wait (UDP datagrams) drop the packet when Take returns false.
func (l *Limiter) Take(rateKbps int, n int) bool {
	if rateKbps <= 0 {
		return true
	}
	rate := float64(rateKbps) * 1024
	l.refill(rate)
	if l.tokens < float64(n) {
		return false
	}
	l.tokens -= float64(n)
	return true
}

// Reserve debits n bytes unconditionally and returns how long the caller
// must wait before sending them so the long-run rate stays at rateKbps.
// Stream callers (TCP) sleep for the returned duration instead of failing.
func (l *Limiter) Reserve(rateKbps int, n int) time.Duration {
	if rateKbps <= 0 || n <= 0 {
		return 0
	}
	rate := float64(rateKbps) * 1024
	l.refill(rate)
	l.tokens -= float64(n)
	if l.tokens >= 0 {
		return 0
	}
	return time.Duration(-l.tokens / rate * float64(time.Second))
}

func IntOr(v, d int) int {
	if v <= 0 {
		return d
	}
	return v
}

const (
	DefaultSPATimeoutSec = 60
	DefaultUDPIdleSec    = 60
	MaxTimeoutSec        = 86400
)

func ClampTimeoutSec(v, def int) int {
	if v <= 0 {
		return def
	}
	if v > MaxTimeoutSec {
		return MaxTimeoutSec
	}
	return v
}

func SPATimeout(sec int) time.Duration {
	return time.Duration(ClampTimeoutSec(sec, DefaultSPATimeoutSec)) * time.Second
}

func UDPIdle(udpSec, idleSec int) time.Duration {
	if udpSec > 0 {
		return time.Duration(ClampTimeoutSec(udpSec, DefaultUDPIdleSec)) * time.Second
	}
	return time.Duration(IntOr(idleSec, DefaultUDPIdleSec)) * time.Second
}

const DefaultMaxConns = 1024

func MaxConns(v int) int {
	return IntOr(v, DefaultMaxConns)
}

func Atoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}
