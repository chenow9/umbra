package control

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"time"
)

const (
	trafficSchema   = 1
	trafficByKeep   = time.Hour
	trafficFileName = "traffic"
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

func encodeTrafficFile(samples []sampleRec, now time.Time) ([]byte, error) {
	cutoff := now.Add(-trafficByKeep)
	out := make([]trafficPoint, 0, len(samples))
	for _, s := range samples {
		p := trafficPoint{T: s.Ts.Unix(), In: s.In, Out: s.Out}
		if !s.Ts.Before(cutoff) && len(s.By) > 0 {
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
	if len(out) > 10000 {
		out = out[len(out)-10000:]
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
	c.samples = samples
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
