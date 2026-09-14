package control

import (
	"testing"
	"time"
)

// An attacker failing from a couple of addresses arms the global backoff,
// but it must not lock out an administrator logging in from an address
// that has not failed. The failing addresses themselves stay throttled.
func TestGlobalBackoffSparesCleanAddresses(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	now := base
	old := nowFn
	nowFn = func() time.Time { return now }
	t.Cleanup(func() { nowFn = old })

	a := newAuthRate()
	attackers := []string{"198.51.100.1", "198.51.100.2"}
	for i := 0; i < globalFree+3; i++ {
		ip := attackers[i%len(attackers)]
		if err := a.allow(ip); err != nil {
			// Attacker addresses may themselves hit the backoff; that
			// is the intended effect.
			continue
		}
		a.fail(ip)
	}
	if !now.Before(a.notBefore) {
		t.Fatal("global backoff should be armed after repeated failures")
	}
	if err := a.allow("203.0.113.7"); err != nil {
		t.Fatalf("clean address must be admitted during global backoff: %v", err)
	}
	var rl *rateLimitError
	if err := a.allow(attackers[0]); !asRateLimit(err, &rl) {
		t.Fatalf("failing address should still be backed off, got %v", err)
	}

	// Once the clean address fails it joins the throttled set.
	a.fail("203.0.113.7")
	if err := a.allow("203.0.113.7"); !asRateLimit(err, &rl) {
		t.Fatalf("address with a recent failure must honour the backoff, got %v", err)
	}

	// After the window the record expires and the address is clean again.
	now = base.Add(ipFailWindow + time.Second)
	a.notBefore = now.Add(time.Minute)
	if err := a.allow("203.0.113.7"); err != nil {
		t.Fatalf("expired record should be treated as clean: %v", err)
	}
}
