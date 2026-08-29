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
