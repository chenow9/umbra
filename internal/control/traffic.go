package control

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"time"
)

const (
	trafficSchema     = 1
	trafficKeep       = 7 * 24 * time.Hour
	trafficRawKeep    = time.Hour
	trafficMinuteKeep = 24 * time.Hour
	trafficFileName   = "traffic"
)

type trafficFile struct {
	Schema  int            `json:"schema"`
	Samples []trafficPoint `json:"samples"`
}

type trafficPoint struct {
	T   int64               `json:"t"`
	In  int64               `json:"i"`
	Out int64               `json:"o"`
	By  map[string][2]int64 `json:"by,omitempty"`
}

func (c *Console) trafficPath() string {
	if c.Persist == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(c.Persist), trafficFileName)
}

func trafficWindow(rangeName string, now time.Time) (since time.Time, step time.Duration) {
	switch rangeName {
	case "1h":
		return now.Add(-time.Hour), 0
	case "7d":
		return now.Add(-7 * 24 * time.Hour), 5 * time.Minute
	default:
		return now.Add(-24 * time.Hour), time.Minute
	}
}

func bucketSamples(in []sampleRec, step time.Duration) []sampleRec {
	if step <= 0 || len(in) < 2 {
		return in
	}
	sec := int64(step / time.Second)
	if sec <= 0 {
		return in
	}
	out := make([]sampleRec, 0, len(in))
	var prev int64 = -1
	for _, s := range in {
		b := s.Ts.Unix() / sec
		if len(out) > 0 && b == prev {
			out[len(out)-1] = s
			continue
		}
		out = append(out, s)
		prev = b
	}
	return out
}

// compactSamples keeps 7d of history: 10s in the last hour, 1min for 24h, 5min beyond.
func compactSamples(samples []sampleRec, now time.Time) []sampleRec {
	if len(samples) == 0 {
		return samples
	}
	keepFrom := now.Add(-trafficKeep)
	rawFrom := now.Add(-trafficRawKeep)
	minuteFrom := now.Add(-trafficMinuteKeep)
	out := make([]sampleRec, 0, 4096)
	var prevBucket int64
	var prevStep time.Duration
	bucketed := false
	for _, s := range samples {
		if s.Ts.Before(keepFrom) {
			continue
		}
		var step time.Duration
		switch {
		case !s.Ts.Before(rawFrom):
			step = 0
		case !s.Ts.Before(minuteFrom):
			step = time.Minute
		default:
			step = 5 * time.Minute
		}
		if step == 0 {
			out = append(out, s)
			bucketed = false
			continue
		}
		bucket := s.Ts.Unix() / int64(step/time.Second)
		if bucketed && step == prevStep && bucket == prevBucket {
			out[len(out)-1] = s
			continue
		}
		out = append(out, s)
		prevBucket = bucket
		prevStep = step
		bucketed = true
	}
	return out
}

func encodeTrafficFile(samples []sampleRec, now time.Time) ([]byte, error) {
	samples = compactSamples(samples, now)
	out := make([]trafficPoint, 0, len(samples))
	for _, s := range samples {
		p := trafficPoint{T: s.Ts.Unix(), In: s.In, Out: s.Out}
		if len(s.By) > 0 {
			p.By = s.By
		}
		out = append(out, p)
	}
	return json.Marshal(trafficFile{Schema: trafficSchema, Samples: out})
}

func decodeTrafficFile(raw []byte) ([]sampleRec, error) {
	var f trafficFile
	if err := json.Unmarshal(raw, &f); err != nil {
		return nil, err
	}
	if f.Schema != 0 && f.Schema != trafficSchema {
		return nil, nil
	}
	out := make([]sampleRec, 0, len(f.Samples))
	for _, p := range f.Samples {
		if p.T <= 0 {
			continue
		}
		by := p.By
		if by == nil {
			by = map[string][2]int64{}
		}
		out = append(out, sampleRec{
			Ts:  time.Unix(p.T, 0),
			In:  p.In,
			Out: p.Out,
			By:  by,
		})
	}
	return out, nil
}

func (c *Console) loadTraffic() {
	path := c.trafficPath()
	if path == "" {
		return
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("traffic: %v", err)
		}
		return
	}
	samples, err := decodeTrafficFile(raw)
	if err != nil {
		log.Printf("traffic: 忽略损坏文件: %v", err)
		return
	}
	c.samples = compactSamples(samples, time.Now())
}

func (c *Console) saveTrafficLocked() error {
	path := c.trafficPath()
	if path == "" {
		return nil
	}
	raw, err := encodeTrafficFile(c.samples, time.Now())
	if err != nil {
		return err
	}
	return writeAtomic(path, raw, 0o600)
}

// FlushTraffic writes the in-memory traffic series to tls-dir/traffic.
func (c *Console) FlushTraffic() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.saveTrafficLocked(); err != nil {
		log.Printf("traffic: %v", err)
	}
}
