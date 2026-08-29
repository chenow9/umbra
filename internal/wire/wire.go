package wire

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"sync"
)

const (
	maxJSON  = 256 << 10
	maxDgram = 64 << 10
)

type Envelope struct {
	Type string          `json:"type"`
	Body json.RawMessage `json:"body"`
}

type Mapping struct {
	ID                string `json:"id"`
	Name              string `json:"name"`
	Proto             string `json:"proto"`
	Mode              string `json:"mode"`
	EntryPort         *int   `json:"entry_port"`
	LocalHost         string `json:"local_host"`
	LocalPort         int    `json:"local_port"`
	Enabled           bool   `json:"enabled"`
	MaxConns          int    `json:"max_conns"`
	RateKbps          int    `json:"rate_kbps"`
	AllowCidrs        string `json:"allow_cidrs"`
	IdleTimeoutSec    int    `json:"idle_timeout_sec"`
	SpaTTLSec         int    `json:"spa_ttl_sec,omitempty"`
	UdpIdleTimeoutSec int    `json:"udp_idle_timeout_sec,omitempty"`
	Generation        int64  `json:"generation,omitempty"`
}

type StreamOpen struct {
	MappingID string `json:"mapping_id"`
	Proto     string `json:"proto"`
	PeerIP    string `json:"peer_ip"`
	PeerPort  int    `json:"peer_port"`
	Via       string `json:"via"`
}

type Conn struct {
	rw io.ReadWriter
	mu sync.Mutex
}

func NewConn(rw io.ReadWriter) *Conn { return &Conn{rw: rw} }

func (c *Conn) SendJSON(typ string, body any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	env, err := json.Marshal(Envelope{Type: typ, Body: raw})
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return writeFrame(c.rw, env, maxJSON)
}

func (c *Conn) Read() (Envelope, error) {
	buf, err := readFrame(c.rw, maxJSON)
	if err != nil {
		return Envelope{}, err
	}
	var env Envelope
	if err := json.Unmarshal(buf, &env); err != nil {
		return Envelope{}, err
	}
	return env, nil
}

func Decode[T any](body json.RawMessage) (T, error) {
	var v T
	err := json.Unmarshal(body, &v)
	return v, err
}

func WriteOpen(w io.Writer, o StreamOpen) error {
	raw, err := json.Marshal(o)
	if err != nil {
		return err
	}
	return writeFrame(w, raw, maxJSON)
}

func ReadOpen(r io.Reader) (StreamOpen, error) {
	buf, err := readFrame(r, maxJSON)
	if err != nil {
		return StreamOpen{}, err
	}
	var o StreamOpen
	if err := json.Unmarshal(buf, &o); err != nil {
		return StreamOpen{}, err
	}
	return o, nil
}

func WriteDatagram(w io.Writer, p []byte) error {
	return writeFrame(w, p, maxDgram)
}

func ReadDatagram(r io.Reader) ([]byte, error) {
	return readFrame(r, maxDgram)
}

func writeFrame(w io.Writer, p []byte, max int) error {
	if len(p) > max {
		return fmt.Errorf("bad frame length %d", len(p))
	}
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], uint32(len(p)))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	_, err := w.Write(p)
	return err
}

func readFrame(r io.Reader, max int) ([]byte, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint32(hdr[:])
	if int(n) > max {
		return nil, fmt.Errorf("bad frame length %d", n)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}
