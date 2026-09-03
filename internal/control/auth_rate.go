package control

import (
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"time"
)

const (
	ipFailWindow            = 15 * time.Minute
	ipFailMax               = 8
	globalFree              = 5
	globalCap               = 60 * time.Second
	maxParallelPasswordHash = 2
	maxAuthPassword         = 128
	maxAuthTOTP             = 8
	maxAuthRecovery         = 64
	maxAuthMigration        = 80
	authJSONLimit           = 4 << 10
)

type rateLimitError struct {
	retryAfter time.Duration
}

func (e *rateLimitError) Error() string {
	return "试得太勤，过一会儿再来"
}

func (e *rateLimitError) RetryAfter() time.Duration {
	if e == nil || e.retryAfter < time.Second {
		return time.Second
	}
	return e.retryAfter
}

var (
	rateLimitLogNS    atomic.Int64
	rateLimitLogCount atomic.Int64
	rateLimitLogGap   = time.Second
)

func securityEventRateLimited(ip string, extra ...string) {
	now := nowFn().UnixNano()
	last := rateLimitLogNS.Load()
	if last != 0 && now-last < int64(rateLimitLogGap) {
		return
	}
	if !rateLimitLogNS.CompareAndSwap(last, now) {
		return
	}
	rateLimitLogCount.Add(1)
	securityEvent("auth.rate_limited", ip, extra...)
}

type authRate struct {
	mu        sync.Mutex
	byIP      map[string]hit
	globalN   int
	notBefore time.Time
}

func newAuthRate() *authRate {
	return &authRate{byIP: map[string]hit{}}
}

func globalBackoff(failCount int) time.Duration {
	if failCount <= globalFree {
		return 0
	}
	shift := failCount - globalFree - 1
	if shift < 0 {
		shift = 0
	}
	if shift > 30 {
		shift = 30
	}
	d := time.Duration(1<<uint(shift)) * 2 * time.Second
	if d > globalCap {
		d = globalCap
	}
	return d
}

// allow atomically reserves an attempt. Concurrent callers cannot all
// slip through before fail() runs.
func (a *authRate) allow(ip string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := nowFn()
	if now.Before(a.notBefore) {
		return &rateLimitError{retryAfter: a.notBefore.Sub(now)}
	}
	h := a.byIP[ip]
	if now.Sub(h.t) > ipFailWindow {
		h = hit{}
	}
	if h.n >= ipFailMax {
		left := ipFailWindow - now.Sub(h.t)
		if left < time.Second {
			left = time.Second
		}
		return &rateLimitError{retryAfter: left}
	}
	h.n++
	h.t = now
	a.byIP[ip] = h
	return nil
}

func (a *authRate) fail(ip string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := nowFn()
	h := a.byIP[ip]
	if now.Sub(h.t) > ipFailWindow {
		h = hit{n: 1, t: now}
	} else if h.n < 1 {
		h.n = 1
		h.t = now
	}
	a.byIP[ip] = h
	a.globalN++
	if d := globalBackoff(a.globalN); d > 0 {
		a.notBefore = now.Add(d)
	}
}

func (a *authRate) success(ip string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.byIP, ip)
	a.globalN = 0
	a.notBefore = time.Time{}
}

func (a *authRate) refund(ip string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	h := a.byIP[ip]
	if h.n > 0 {
		h.n--
		if h.n == 0 {
			delete(a.byIP, ip)
		} else {
			a.byIP[ip] = h
		}
	}
}

func retryAfterHeader(err error) string {
	var rl *rateLimitError
	if !asRateLimit(err, &rl) {
		return ""
	}
	sec := int(rl.RetryAfter().Seconds())
	if sec < 1 {
		sec = 1
	}
	return fmt.Sprintf("%d", sec)
}

func asRateLimit(err error, target **rateLimitError) bool {
	if err == nil {
		return false
	}
	e, ok := err.(*rateLimitError)
	if !ok {
		return false
	}
	*target = e
	return true
}

var (
	passwordHashSem = make(chan struct{}, maxParallelPasswordHash)
	hashInFlight    atomic.Int32
	hashPeak        atomic.Int32
)

func acquirePasswordHash() (func(), error) {
	select {
	case passwordHashSem <- struct{}{}:
		n := hashInFlight.Add(1)
		for {
			old := hashPeak.Load()
			if n <= old || hashPeak.CompareAndSwap(old, n) {
				break
			}
		}
		return func() {
			hashInFlight.Add(-1)
			<-passwordHashSem
		}, nil
	default:
		return nil, &rateLimitError{retryAfter: time.Second}
	}
}

func rejectAuthSizes(password, totp, recovery, migration string) error {
	if len(password) > maxAuthPassword || len(totp) > maxAuthTOTP ||
		len(recovery) > maxAuthRecovery || len(migration) > maxAuthMigration {
		return errBadCreds
	}
	return nil
}

func securityEvent(event, ip string, extra ...string) {
	msg := "security event=" + event + " ip=" + ip
	for _, e := range extra {
		if e != "" {
			msg += " " + e
		}
	}
	log.Print(msg)
}
