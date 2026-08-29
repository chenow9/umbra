package gate

import (
	"testing"
	"time"

	"umbra/internal/stealth"
)

func TestSnapshotRestoresNeverExpireToken(t *testing.T) {
	s := New("127.0.0.1", stealth.New(false))
	plain := "umbra_boot_never"
	h := TicketHash(plain)
	s.SetTokenHashUntil(h, "nde_x", time.Time{})
	snap := s.Snapshot()
	if ms, ok := snap.TokenUntil[h]; !ok || ms != 0 {
		t.Fatalf("snapshot until=%v ok=%v want 0", ms, ok)
	}
	s2 := New("127.0.0.1", stealth.New(false))
	s2.Restore(snap)
	if s2.LookupToken(plain) != "nde_x" {
		t.Fatal("restored never-expire token must authenticate")
	}
}
