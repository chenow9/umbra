// Package uplane is the independent UDP data plane.
// Datagrams are AEAD-sealed with directional keys and do not share the
// TCP/yamux control path.
package uplane

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"sync/atomic"
)

const (
	Magic   = "UMU2"
	Version = 2

	TypeBind        byte = 1
	TypeData        byte = 2
	TypeClose       byte = 3
	TypeBindAck     byte = 4
	TypeBindConfirm byte = 5

	maxID     = 96
	maxMapID  = 96
	maxFlowID = 32
	// MaxUDPDatagram is the IPv4 UDP payload ceiling (65535-20-8).
	MaxUDPDatagram = 65507
	// MaxPayload is the largest application datagram accepted on the
	// independent UDP plane. 8192 fits Darwin's default udp.maxdgram
	// (9216) after worst-case uplane/AEAD overhead, and is well under
	// Linux IPv4 UDP 65507. Larger values are rejected at Encode.
	MaxPayload  = 8192
	SafePayload = 1200
	nonceSize   = 12
	hdrMin      = 4 + 1 + 1
	WindowBits  = 64
	gcmOverhead = 16
)

var bufPool = sync.Pool{New: func() any {
	b := make([]byte, MaxUDPDatagram)
	return &b
}}

func GetBuf() []byte  { return *bufPool.Get().(*[]byte) }
func PutBuf(b []byte) { bufPool.Put(&b) }

func DerivePair(ekm, cookie []byte) (c2s, s2c []byte) {
	return derive("umbra-udp-v2-c2s", ekm, cookie), derive("umbra-udp-v2-s2c", ekm, cookie)
}

func derive(label string, ekm, cookie []byte) []byte {
	h := sha256.New()
	_, _ = io.WriteString(h, label)
	h.Write(cookie)
	h.Write(ekm)
	return h.Sum(nil)
}

func ExportEKM(c net.Conn) []byte {
	type stater interface{ ConnectionState() tls.ConnectionState }
	s, ok := c.(stater)
	if !ok {
		return nil
	}
	cs := s.ConnectionState()
	ekm, err := cs.ExportKeyingMaterial("umbra udp v1", nil, 32)
	if err != nil || len(ekm) != 32 {
		return nil
	}
	return ekm
}

type Packet struct {
	Type      byte
	Seq       uint64
	MappingID string
	FlowID    string
	PeerIP    net.IP
	PeerPort  int
	Payload   []byte
}

func NewFlowID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return ""
	}
	return hex.EncodeToString(b[:])
}

func Overhead(id, mapping, flow string, ipv6 bool) int {
	iplen := 4
	if ipv6 {
		iplen = 16
	}
	return hdrMin + len(id) + nonceSize + gcmOverhead + 1 + 8 + 1 + len(mapping) + 1 + len(flow) + 1 + iplen + 2
}

func PeekID(raw []byte) (string, error) {
	if len(raw) < hdrMin {
		return "", io.ErrUnexpectedEOF
	}
	if string(raw[:4]) != Magic || raw[4] != Version {
		return "", fmt.Errorf("bad uplane header")
	}
	n := int(raw[5])
	if n == 0 || n > maxID || len(raw) < hdrMin+n+nonceSize {
		return "", fmt.Errorf("bad uplane id")
	}
	return string(raw[hdrMin : hdrMin+n]), nil
}

func Encode(key []byte, id string, p Packet) ([]byte, error) {
	if len(id) == 0 || len(id) > maxID {
		return nil, fmt.Errorf("bad id")
	}
	if len(p.MappingID) > maxMapID {
		return nil, fmt.Errorf("bad mapping id")
	}
	if len(p.FlowID) > maxFlowID {
		return nil, fmt.Errorf("bad flow id")
	}
	if len(p.Payload) > MaxPayload {
		return nil, fmt.Errorf("payload too large")
	}
	if p.Seq == 0 {
		return nil, fmt.Errorf("bad seq")
	}
	inner := marshalInner(p)
	gcm, err := aead(key)
	if err != nil {
		return nil, err
	}
	var nonce [nonceSize]byte
	binary.BigEndian.PutUint64(nonce[4:], p.Seq)
	idb := []byte(id)
	out := make([]byte, 0, hdrMin+len(idb)+nonceSize+len(inner)+gcm.Overhead())
	out = append(out, Magic...)
	out = append(out, Version, byte(len(idb)))
	out = append(out, idb...)
	out = append(out, nonce[:]...)
	aad := out[:hdrMin+len(idb)]
	sealed := gcm.Seal(out, nonce[:], inner, aad)
	if len(sealed) > MaxUDPDatagram {
		return nil, fmt.Errorf("datagram too large")
	}
	return sealed, nil
}

func Decode(key, raw []byte) (string, Packet, error) {
	id, err := PeekID(raw)
	if err != nil {
		return "", Packet{}, err
	}
	gcm, err := aead(key)
	if err != nil {
		return "", Packet{}, err
	}
	idLen := int(raw[5])
	off := hdrMin + idLen
	nonce := raw[off : off+nonceSize]
	ct := raw[off+nonceSize:]
	plain, err := gcm.Open(nil, nonce, ct, raw[:off])
	if err != nil {
		return "", Packet{}, err
	}
	p, err := unmarshalInner(plain)
	return id, p, err
}

func aead(key []byte) (cipher.AEAD, error) {
	if len(key) != 32 {
		return nil, fmt.Errorf("bad udp key")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func marshalInner(p Packet) []byte {
	ip := p.PeerIP
	if ip == nil {
		ip = net.IPv4zero
	}
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	mapb := []byte(p.MappingID)
	flow := []byte(p.FlowID)
	out := make([]byte, 0, 1+8+1+len(mapb)+1+len(flow)+1+len(ip)+2+len(p.Payload))
	out = append(out, p.Type)
	var seq [8]byte
	binary.BigEndian.PutUint64(seq[:], p.Seq)
	out = append(out, seq[:]...)
	out = append(out, byte(len(mapb)))
	out = append(out, mapb...)
	out = append(out, byte(len(flow)))
	out = append(out, flow...)
	out = append(out, byte(len(ip)))
	out = append(out, ip...)
	var port [2]byte
	binary.BigEndian.PutUint16(port[:], uint16(p.PeerPort))
	out = append(out, port[:]...)
	return append(out, p.Payload...)
}

func unmarshalInner(b []byte) (Packet, error) {
	if len(b) < 1+8+1+1+2 {
		return Packet{}, io.ErrUnexpectedEOF
	}
	p := Packet{Type: b[0], Seq: binary.BigEndian.Uint64(b[1:9])}
	if p.Seq == 0 {
		return Packet{}, fmt.Errorf("bad seq")
	}
	ml := int(b[9])
	if ml > maxMapID || len(b) < 10+ml+1+1+2 {
		return Packet{}, fmt.Errorf("bad inner mapping")
	}
	p.MappingID = string(b[10 : 10+ml])
	off := 10 + ml
	fl := int(b[off])
	off++
	if fl > maxFlowID || len(b) < off+fl+1+2 {
		return Packet{}, fmt.Errorf("bad inner flow")
	}
	p.FlowID = string(b[off : off+fl])
	off += fl
	ipl := int(b[off])
	off++
	if ipl != 4 && ipl != 16 {
		return Packet{}, fmt.Errorf("bad inner ip")
	}
	if len(b) < off+ipl+2 {
		return Packet{}, io.ErrUnexpectedEOF
	}
	p.PeerIP = append(net.IP(nil), b[off:off+ipl]...)
	off += ipl
	p.PeerPort = int(binary.BigEndian.Uint16(b[off : off+2]))
	off += 2
	if len(b)-off > MaxPayload {
		return Packet{}, fmt.Errorf("payload too large")
	}
	if off < len(b) {
		p.Payload = append([]byte(nil), b[off:]...)
	}
	return p, nil
}

type Window struct {
	max  uint64
	bits uint64
}

func (w *Window) Accept(seq uint64) bool {
	if seq == 0 {
		return false
	}
	if seq > w.max {
		shift := seq - w.max
		if shift >= WindowBits {
			w.bits = 1
		} else {
			w.bits = (w.bits << shift) | 1
		}
		w.max = seq
		return true
	}
	off := w.max - seq
	if off >= WindowBits {
		return false
	}
	mask := uint64(1) << off
	if w.bits&mask != 0 {
		return false
	}
	w.bits |= mask
	return true
}

type Sealer struct {
	Key []byte
	seq atomic.Uint64
}

func (s *Sealer) Encode(id string, p Packet) ([]byte, error) {
	p.Seq = s.seq.Add(1)
	return Encode(s.Key, id, p)
}

// ErrWriterEncode identifies a Writer failure that happened before the
// datagram reached the supplied socket write function.
var ErrWriterEncode = errors.New("uplane writer encode")

// Writer keeps sequence allocation, packet encoding, and the socket write in
// one ordered critical section. Callers sharing a directional key must share
// one Writer so the packet sequence observed on the wire cannot be reordered
// by concurrent goroutines after sequence allocation.
type Writer struct {
	Key []byte
	mu  sync.Mutex
	seq uint64
}

// Write encodes p and calls send while holding the directional writer lock.
// A failed socket write consumes its sequence number, which is safe because
// the receiver's replay window permits gaps.
func (w *Writer) Write(id string, p Packet, send func([]byte) (int, error)) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.seq++
	p.Seq = w.seq
	raw, err := Encode(w.Key, id, p)
	if err != nil {
		return 0, fmt.Errorf("%w: %v", ErrWriterEncode, err)
	}
	n, err := send(raw)
	if err == nil && n != len(raw) {
		err = io.ErrShortWrite
	}
	return n, err
}

type Opener struct {
	Key []byte
	mu  sync.Mutex
	Win Window
}

func (o *Opener) Decode(raw []byte) (string, Packet, error) {
	id, p, err := Decode(o.Key, raw)
	if err != nil {
		return "", Packet{}, err
	}
	o.mu.Lock()
	ok := o.Win.Accept(p.Seq)
	o.mu.Unlock()
	if !ok {
		return "", Packet{}, fmt.Errorf("replay")
	}
	return id, p, nil
}
