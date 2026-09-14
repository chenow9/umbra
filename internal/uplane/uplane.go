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

// Encode seals p for id with key into a freshly allocated datagram. Hot
// paths should go through Writer, which caches the cipher and reuses a
// pooled buffer; Encode keeps the one-shot form for tests and tooling.
func Encode(key []byte, id string, p Packet) ([]byte, error) {
	gcm, err := aead(key)
	if err != nil {
		return nil, err
	}
	return appendEncode(nil, gcm, id, p)
}

// appendEncode appends the sealed datagram for p to dst. The header, nonce
// and inner record are laid out once in dst and sealed in place, so the
// payload is copied exactly once.
func appendEncode(dst []byte, gcm cipher.AEAD, id string, p Packet) ([]byte, error) {
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
	start := len(dst)
	need := hdrMin + len(id) + nonceSize + innerLen(p) + gcm.Overhead()
	if cap(dst)-start < need {
		grown := make([]byte, start, start+need)
		copy(grown, dst)
		dst = grown
	}
	out := append(dst, Magic...)
	out = append(out, Version, byte(len(id)))
	out = append(out, id...)
	nonceOff := len(out)
	out = append(out, make([]byte, nonceSize)...)
	binary.BigEndian.PutUint64(out[nonceOff+4:nonceOff+nonceSize], p.Seq)
	aadEnd := nonceOff
	plainOff := len(out)
	out = appendInner(out, p)
	// Seal in place: dst is out[:plainOff] whose spare capacity begins
	// exactly at the plaintext, the pattern cipher.AEAD documents as safe.
	sealed := gcm.Seal(out[:plainOff], out[nonceOff:nonceOff+nonceSize], out[plainOff:], out[start:aadEnd])
	if len(sealed)-start > MaxUDPDatagram {
		return nil, fmt.Errorf("datagram too large")
	}
	return sealed, nil
}

// Decode authenticates raw with key and returns an independent Packet.
// raw is used as scratch for the plaintext and must be considered
// clobbered afterwards.
func Decode(key, raw []byte) (string, Packet, error) {
	gcm, err := aead(key)
	if err != nil {
		return "", Packet{}, err
	}
	return decodeWith(gcm, raw)
}

func decodeWith(gcm cipher.AEAD, raw []byte) (string, Packet, error) {
	id, err := PeekID(raw)
	if err != nil {
		return "", Packet{}, err
	}
	idLen := int(raw[5])
	off := hdrMin + idLen
	nonce := raw[off : off+nonceSize]
	ct := raw[off+nonceSize:]
	// Open in place: the plaintext lands where the ciphertext was, and
	// unmarshalInner copies the fields it keeps out of it.
	plain, err := gcm.Open(ct[:0], nonce, ct, raw[:off])
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

func wireIP(ip net.IP) net.IP {
	if ip == nil {
		return net.IPv4zero.To4()
	}
	if v4 := ip.To4(); v4 != nil {
		return v4
	}
	return ip
}

func innerLen(p Packet) int {
	return 1 + 8 + 1 + len(p.MappingID) + 1 + len(p.FlowID) + 1 + len(wireIP(p.PeerIP)) + 2 + len(p.Payload)
}

func appendInner(out []byte, p Packet) []byte {
	ip := wireIP(p.PeerIP)
	out = append(out, p.Type)
	var seq [8]byte
	binary.BigEndian.PutUint64(seq[:], p.Seq)
	out = append(out, seq[:]...)
	out = append(out, byte(len(p.MappingID)))
	out = append(out, p.MappingID...)
	out = append(out, byte(len(p.FlowID)))
	out = append(out, p.FlowID...)
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
	gcm cipher.AEAD // built from Key on first use
}

// Write encodes p and calls send while holding the directional writer lock.
// A failed socket write consumes its sequence number, which is safe because
// the receiver's replay window permits gaps. The datagram is assembled in a
// pooled buffer that is only valid for the duration of send.
func (w *Writer) Write(id string, p Packet, send func([]byte) (int, error)) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.gcm == nil {
		gcm, err := aead(w.Key)
		if err != nil {
			return 0, fmt.Errorf("%w: %v", ErrWriterEncode, err)
		}
		w.gcm = gcm
	}
	w.seq++
	p.Seq = w.seq
	buf := GetBuf()
	defer PutBuf(buf)
	raw, err := appendEncode(buf[:0], w.gcm, id, p)
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
	gcm cipher.AEAD // built from Key on first use
}

// Decode authenticates raw, enforces the replay window and returns a Packet
// that does not alias raw. raw is used as scratch and is clobbered.
func (o *Opener) Decode(raw []byte) (string, Packet, error) {
	o.mu.Lock()
	gcm := o.gcm
	if gcm == nil {
		var err error
		if gcm, err = aead(o.Key); err != nil {
			o.mu.Unlock()
			return "", Packet{}, err
		}
		o.gcm = gcm
	}
	o.mu.Unlock()
	id, p, err := decodeWith(gcm, raw)
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
