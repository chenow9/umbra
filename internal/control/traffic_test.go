package control

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"umbra/internal/gate"
	"umbra/internal/stealth"
)

func TestEncodeTrafficStripsOldBy(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	samples := []sampleRec{
		{Ts: now.Add(-2 * time.Hour), In: 10, Out: 11, By: map[string][2]int64{"map_old": {1, 2}}},
		{Ts: now.Add(-10 * time.Minute), In: 20, Out: 21, By: map[string][2]int64{"map_new": {3, 4}}},
	}
	raw, err := encodeTrafficFile(samples, now)
	if err != nil {
		t.Fatal(err)
	}
	var f trafficFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if f.Schema != trafficSchema || len(f.Samples) != 2 {
		t.Fatalf("file %+v", f)
	}
	if f.Samples[0].By != nil {
		t.Fatalf("old point should drop By: %+v", f.Samples[0])
	}
	if f.Samples[1].By["map_new"] != [2]int64{3, 4} {
		t.Fatalf("recent By %v", f.Samples[1].By)
	}
}

func TestTrafficRoundTripAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "control.json")
	now := time.Now().Truncate(time.Second)
	c1, err := New(gate.New("127.0.0.1", stealth.New(false)), path)
	if err != nil {
		t.Fatal(err)
	}
	c1.mu.Lock()
	c1.samples = []sampleRec{
		{Ts: now.Add(-2 * time.Hour), In: 100, Out: 80, By: map[string][2]int64{"map_a": {100, 80}}},
		{Ts: now, In: 150, Out: 90, By: map[string][2]int64{"map_a": {150, 90}}},
	}
	if err := c1.saveTrafficLocked(); err != nil {
		t.Fatal(err)
	}
	c1.mu.Unlock()

	if _, err := os.Stat(filepath.Join(dir, "traffic")); err != nil {
		t.Fatal(err)
	}

	c2, err := New(gate.New("127.0.0.1", stealth.New(false)), path)
	if err != nil {
		t.Fatal(err)
	}
	if len(c2.samples) != 2 {
		t.Fatalf("samples %d", len(c2.samples))
	}
	if c2.samples[0].In != 100 || c2.samples[0].Out != 80 {
		t.Fatalf("old totals %+v", c2.samples[0])
	}
	if len(c2.samples[0].By) != 0 {
		t.Fatalf("old By should not be reloaded: %v", c2.samples[0].By)
	}
	if c2.samples[1].By["map_a"] != [2]int64{150, 90} {
		t.Fatalf("recent By %v", c2.samples[1].By)
	}
}

func TestTrafficCorruptFileDoesNotFailStart(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "control.json")
	if err := os.WriteFile(filepath.Join(dir, "traffic"), []byte("not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := New(gate.New("127.0.0.1", stealth.New(false)), path)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.samples) != 0 {
		t.Fatalf("samples %d", len(c.samples))
	}
}
