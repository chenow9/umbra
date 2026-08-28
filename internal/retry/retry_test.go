package retry

import (
	"context"
	"testing"
	"time"
)

func TestJitteredStaysInRange(t *testing.T) {
	d := 2 * time.Second
	for i := 0; i < 40; i++ {
		got := jittered(d)
		if got < d/2 || got > d/2+d {
			t.Fatalf("jitter %s outside [%s, %s]", got, d/2, d/2+d)
		}
	}
}

func TestSleepCancels(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if Sleep(ctx, time.Second) {
		t.Fatal("cancelled context must not sleep the full backoff")
	}
}

func TestNextCaps(t *testing.T) {
	d := Initial
	for i := 0; i < 10; i++ {
		d = Next(d)
	}
	if d != Max {
		t.Fatalf("got %s want %s", d, Max)
	}
}

func TestJitteredSpreadsReconnects(t *testing.T) {
	seen := map[time.Duration]int{}
	d := 200 * time.Millisecond
	for i := 0; i < 80; i++ {
		seen[jittered(d)/time.Millisecond]++
	}
	if len(seen) < 10 {
		t.Fatalf("jitter collapsed to %d buckets; reconnects would stampede", len(seen))
	}
}
