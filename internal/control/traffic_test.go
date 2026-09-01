package control

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"umbra/internal/gate"
	"umbra/internal/stealth"
	"umbra/internal/wire"
)

func TestEncodeTrafficKeepsByForHistory(t *testing.T) {
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
	if f.Samples[0].By["map_old"] != [2]int64{1, 2} {
		t.Fatalf("history By %v", f.Samples[0].By)
	}
	if f.Samples[1].By["map_new"] != [2]int64{3, 4} {
		t.Fatalf("recent By %v", f.Samples[1].By)
	}
}

func TestCompactSamplesKeepsRawHour(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	var in []sampleRec
	for i := 0; i < 720; i++ {
		ts := now.Add(time.Duration(i-719) * 10 * time.Second)
		in = append(in, sampleRec{Ts: ts, In: int64(i), Out: int64(i), By: map[string][2]int64{"m": {int64(i), int64(i)}}})
	}
	out := compactSamples(in, now)
	if len(out) < 410 || len(out) > 430 {
		t.Fatalf("len %d want ~360 raw + ~60 minute", len(out))
	}
	lastHour := 0
	for _, s := range out {
		if !s.Ts.Before(now.Add(-time.Hour)) {
			lastHour++
		}
	}
	if lastHour < 355 || lastHour > 365 {
		t.Fatalf("last-hour points %d", lastHour)
	}
	if out[len(out)-1].By["m"] != [2]int64{719, 719} {
		t.Fatalf("by %+v", out[len(out)-1].By)
	}
}

func TestCompactSamplesFiveMinuteAndDropOld(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	var in []sampleRec
	start := now.Add(-26 * time.Hour)
	end := now.Add(-25 * time.Hour)
	for ts := start; !ts.After(end); ts = ts.Add(10 * time.Second) {
		in = append(in, sampleRec{Ts: ts, In: 1, Out: 1, By: map[string][2]int64{"m": {1, 1}}})
	}
	in = append(in,
		sampleRec{Ts: now.Add(-8 * 24 * time.Hour), In: 9, Out: 9},
		sampleRec{Ts: now, In: 2, Out: 2, By: map[string][2]int64{"m": {2, 2}}},
	)
	out := compactSamples(in, now)
	var mid []sampleRec
	for _, s := range out {
		if s.In == 9 {
			t.Fatalf("kept sample older than 7d: %+v", s)
		}
		if s.Ts.Before(now.Add(-24 * time.Hour)) {
			mid = append(mid, s)
		}
	}
	if len(mid) < 10 || len(mid) > 14 {
		t.Fatalf("5min points %d", len(mid))
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
	if c2.samples[0].By["map_a"] != [2]int64{100, 80} {
		t.Fatalf("old By %v", c2.samples[0].By)
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

func TestBucketSamplesMinute(t *testing.T) {
	now := time.Unix(1_800_000_000, 0).UTC()
	var in []sampleRec
	for i := 0; i < 12; i++ {
		in = append(in, sampleRec{Ts: now.Add(time.Duration(i) * 10 * time.Second), In: int64(i), Out: int64(i)})
	}
	out := bucketSamples(in, time.Minute)
	if len(out) != 2 {
		t.Fatalf("len %d want 2", len(out))
	}
	if out[0].In != 5 || out[1].In != 11 {
		t.Fatalf("kept %+v %+v", out[0], out[1])
	}
}

func TestGetTrafficHonorsRange(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	now := time.Now()
	c.mu.Lock()
	c.samples = []sampleRec{
		{Ts: now.Add(-8 * 24 * time.Hour), In: 1, Out: 1},
		{Ts: now.Add(-3 * 24 * time.Hour), In: 2, Out: 2},
		{Ts: now.Add(-2 * time.Hour), In: 3, Out: 3},
		{Ts: now.Add(-10 * time.Minute), In: 4, Out: 4},
	}
	c.mu.Unlock()

	assertCount := func(rangeQ string, want int) {
		t.Helper()
		resp, err := http.Get(srv.URL + "/v1/traffic?range=" + rangeQ)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var body struct {
			Series []struct {
				Ts string `json:"ts"`
			} `json:"series"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if len(body.Series) != want {
			t.Fatalf("range %s: got %d want %d", rangeQ, len(body.Series), want)
		}
	}
	assertCount("1h", 1)
	assertCount("24h", 2)
	assertCount("7d", 3)
}

func TestGetTrafficMappingSkipsPointsWithoutBy(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	now := time.Now()
	c.mu.Lock()
	c.maps["map_a"] = &mapRec{Spec: wire.Mapping{ID: "map_a", Name: "a"}, NodeID: "n1"}
	c.samples = []sampleRec{
		{Ts: now.Add(-2 * time.Hour), In: 100, Out: 100},
		{Ts: now.Add(-10 * time.Minute), In: 200, Out: 200, By: map[string][2]int64{"map_a": {50, 60}}},
	}
	c.mu.Unlock()

	resp, err := http.Get(srv.URL + "/v1/traffic?range=24h&mappingId=map_a")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body struct {
		Series []struct {
			Ts      string `json:"ts"`
			BytesIn int64  `json:"bytesIn"`
		} `json:"series"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.Series) != 1 {
		t.Fatalf("got %d %+v", len(body.Series), body.Series)
	}
	if body.Series[0].BytesIn != 50 {
		t.Fatalf("%+v", body.Series[0])
	}
}
