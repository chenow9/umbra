package wire

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"sync"
)

const (
	KindJSON  byte = 0
	KindData  byte = 1
	KindClose byte = 2
)

type Envelope struct {
	Type string          `json:"type"`
	Body json.RawMessage `json:"body"`
}

type Mapping struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Proto          string `json:"proto"`
	Mode           string `json:"mode"`
	EntryPort      *int   `json:"entry_port"`
	LocalHost      string `json:"local_host"`
	LocalPort      int    `json:"local_port"`
	Enabled        bool   `json:"enabled"`
	MaxConns       int    `json:"max_conns"`
	RateKbps       int    `json:"rate_kbps"`
	AllowCidrs     string `json:"allow_cidrs"`
	IdleTimeoutSec int    `json:"idle_timeout_sec"`
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
	return c.send(KindJSON, 0, env)
}

func (c *Conn) SendData(streamID uint32, payload []byte) error {
	return c.send(KindData, streamID, payload)
}

func (c *Conn) SendClose(streamID uint32) error {
	return c.send(KindClose, streamID, nil)
}

func (c *Conn) send(kind byte, streamID uint32, payload []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 1
	if kind != KindJSON {
		n += 4
	}
	n += len(payload)
	var hdr [5]byte
	binary.BigEndian.PutUint32(hdr[:4], uint32(n))
	hdr[4] = kind
	if _, err := c.rw.Write(hdr[:]); err != nil {
		return err
	}
	if kind != KindJSON {
		var sid [4]byte
		binary.BigEndian.PutUint32(sid[:], streamID)
		if _, err := c.rw.Write(sid[:]); err != nil {
			return err
		}
	}
	if len(payload) > 0 {
		_, err := c.rw.Write(payload)
		return err
	}
	return nil
}

type Frame struct {
	Kind     byte
	StreamID uint32
	Type     string
	Body     json.RawMessage
	Payload  []byte
}

func (c *Conn) Read() (Frame, error) {
	var hdr [5]byte
	if _, err := io.ReadFull(c.rw, hdr[:]); err != nil {
		return Frame{}, err
	}
	n := binary.BigEndian.Uint32(hdr[:4])
	if n == 0 || n > 8<<20 {
		return Frame{}, fmt.Errorf("bad frame length %d", n)
	}
	kind := hdr[4]
	buf := make([]byte, n-1)
	if _, err := io.ReadFull(c.rw, buf); err != nil {
		return Frame{}, err
	}
	f := Frame{Kind: kind}
	if kind == KindJSON {
		var env Envelope
		if err := json.Unmarshal(buf, &env); err != nil {
			return Frame{}, err
		}
		f.Type = env.Type
		f.Body = env.Body
		return f, nil
	}
	if len(buf) < 4 {
		return Frame{}, fmt.Errorf("short stream frame")
	}
	f.StreamID = binary.BigEndian.Uint32(buf[:4])
	if kind == KindData {
		f.Payload = buf[4:]
	}
	return f, nil
}

func Decode[T any](body json.RawMessage) (T, error) {
	var v T
	err := json.Unmarshal(body, &v)
	return v, err
}
