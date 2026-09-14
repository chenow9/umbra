package policy

import (
	"testing"
	"time"
)

func TestClampAndTimeouts(t *testing.T) {
	if got := ClampTimeoutSec(0, 60); got != 60 {
		t.Fatalf("default %d", got)
	}
	if got := ClampTimeoutSec(15, 60); got != 15 {
		t.Fatalf("keep %d", got)
	}
	if got := ClampTimeoutSec(100000, 60); got != MaxTimeoutSec {
		t.Fatalf("cap %d", got)
	}
	if SPATimeout(0) != 60*time.Second {
		t.Fatal("spa default")
	}
	if UDPIdle(0, 0) != 60*time.Second {
		t.Fatal("udp default")
	}
	if UDPIdle(0, 12) != 12*time.Second {
		t.Fatal("udp fallback to idle")
	}
	if UDPIdle(9, 12) != 9*time.Second {
		t.Fatal("udp explicit")
	}
}

func TestLimiterShapesInsteadOfCutting(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	l := Limiter{nowFn: func() time.Time { return now }}
	// 1 KiB/s: a full second of budget is available up front.
	if w := l.Reserve(1, 1024); w != 0 {
		t.Fatalf("burst within budget should not wait, got %v", w)
	}
	// The next 512 bytes overdraw the bucket by half a second.
	if w := l.Reserve(1, 512); w != 500*time.Millisecond {
		t.Fatalf("overdraw wait = %v, want 500ms", w)
	}
	// Datagram path: nothing fits until time passes.
	if l.Take(1, 1) {
		t.Fatal("Take must fail while overdrawn")
	}
	now = now.Add(time.Second)
	// One second refills 1024 bytes; the -512 debt leaves 512 available.
	if !l.Take(1, 512) {
		t.Fatal("Take should succeed after refill")
	}
	if l.Take(1, 1) {
		t.Fatal("bucket should be empty again")
	}
	// Unlimited mappings never wait.
	if w := l.Reserve(0, 1<<20); w != 0 {
		t.Fatalf("rate 0 must not wait, got %v", w)
	}
}
