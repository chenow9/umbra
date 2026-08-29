package policy

import (
	"net"
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

func CidrAllowed(ip string, cidrs string) bool {
	list := strings.FieldsFunc(cidrs, func(r rune) bool { return r == ',' || r == ' ' || r == '\n' })
	if len(list) == 0 {
		return true
	}
	parsed := net.ParseIP(NormalizeIP(ip))
	if parsed == nil {
		return false
	}
	if v4 := parsed.To4(); v4 != nil {
		parsed = v4
	}
	for _, raw := range list {
		if !strings.Contains(raw, "/") {
			if parsed.To4() != nil {
				raw += "/32"
			} else {
				raw += "/128"
			}
		}
		_, netw, err := net.ParseCIDR(raw)
		if err != nil {
			continue
		}
		if netw.Contains(parsed) {
			return true
		}
	}
	return false
}

type Window struct {
	Start time.Time
	Bytes int
}

func (w *Window) Take(rateKbps int, n int) bool {
	if rateKbps <= 0 {
		return true
	}
	now := time.Now()
	if now.Sub(w.Start) > time.Second {
		w.Start = now
		w.Bytes = 0
	}
	if w.Bytes+n > rateKbps*1024 {
		return false
	}
	w.Bytes += n
	return true
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
