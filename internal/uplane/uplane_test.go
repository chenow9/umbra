package uplane

import (
	"bytes"
	"encoding/hex"
	"errors"
	"net"
	"sync"
	"testing"
	"time"
)

func testKeys() (c2s, s2c []byte) {
	ekm := bytes.Repeat([]byte{7}, 32)
	return DerivePair(ekm, []byte("cookie-16-bytes!"))
}

func TestNewFlowIDIs128Bit(t *testing.T) {
	id := NewFlowID()
	if len(id) != 32 {
		t.Fatalf("len=%d want 32 hex chars (128-bit)", len(id))
	}
	raw, err := hex.DecodeString(id)
	if err != nil || len(raw) != 16 {
		t.Fatalf("decode %v len=%d", err, len(raw))
	}
	other := NewFlowID()
	if other == "" || other == id {
		t.Fatal("flow ids must be unique")
	}
}

// Writer seals into a pooled buffer and Decode opens in place; the Packet a
// receiver gets back must not alias either buffer.
func TestWriterOpenerDoNotAliasBuffers(t *testing.T) {
	c2s, _ := testKeys()
	w := &Writer{Key: c2s}
	o := &Opener{Key: c2s}
	payload := bytes.Repeat([]byte{0xAB}, 1500)
	var raw []byte
	_, err := w.Write("nde1", Packet{Type: TypeData, MappingID: "map", FlowID: "f1", PeerIP: net.IPv4(10, 0, 0, 1), PeerPort: 5, Payload: payload}, func(b []byte) (int, error) {
		raw = append([]byte(nil), b...)
		// Scribble over the pooled buffer after "sending".
		for i := range b {
			b[i] = 0
		}
		return len(b), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// Payload passed in must be untouched (it may alias a read buffer).
	if !bytes.Equal(payload, bytes.Repeat([]byte{0xAB}, 1500)) {
		t.Fatal("writer mutated caller payload")
	}
	ref, err := Encode(c2s, "nde1", Packet{Type: TypeData, Seq: 1, MappingID: "map", FlowID: "f1", PeerIP: net.IPv4(10, 0, 0, 1), PeerPort: 5, Payload: payload})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(raw, ref) {
		t.Fatal("Writer output differs from one-shot Encode")
	}
	id, p, err := o.Decode(raw)
	if err != nil {
		t.Fatal(err)
	}
	for i := range raw {
		raw[i] = 0xFF
	}
	if id != "nde1" || p.MappingID != "map" || p.FlowID != "f1" || p.PeerPort != 5 ||
		!p.PeerIP.Equal(net.IPv4(10, 0, 0, 1)) || !bytes.Equal(p.Payload, payload) {
		t.Fatalf("decoded packet aliases the input buffer: %+v", p)
	}
}

func BenchmarkWriterOpenerRoundtrip(b *testing.B) {
	c2s, _ := testKeys()
	w := &Writer{Key: c2s}
	o := &Opener{Key: c2s}
	payload := make([]byte, SafePayload)
	buf := make([]byte, 0, MaxUDPDatagram)
	b.SetBytes(int64(len(payload)))
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		var raw []byte
		if _, err := w.Write("nde1", Packet{Type: TypeData, MappingID: "map_udp_bench", FlowID: "0123456789abcdef0123456789abcdef", PeerIP: net.IPv4(203, 0, 113, 7), PeerPort: 4444, Payload: payload}, func(bb []byte) (int, error) {
			raw = append(buf[:0], bb...)
			return len(bb), nil
		}); err != nil {
			b.Fatal(err)
		}
		if _, _, err := o.Decode(raw); err != nil {
			b.Fatal(err)
		}
	}
}

func TestPacketRoundtripAndIndependence(t *testing.T) {
	c2s, _ := testKeys()
	a := Packet{Type: TypeData, Seq: 1, MappingID: "map_udp", PeerIP: net.IPv4(127, 0, 0, 1), PeerPort: 9, Payload: []byte("one")}
	b := Packet{Type: TypeData, Seq: 2, MappingID: "map_udp", PeerIP: net.IPv4(127, 0, 0, 1), PeerPort: 9, Payload: []byte("two")}
	ra, err := Encode(c2s, "nde1", a)
	if err != nil {
		t.Fatal(err)
	}
	rb, err := Encode(c2s, "nde1", b)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(ra, rb) {
		t.Fatal("datagrams must not be identical")
	}
	id, pa, err := Decode(c2s, ra)
	if err != nil || id != "nde1" || string(pa.Payload) != "one" || pa.Seq != 1 {
		t.Fatalf("a %q %q seq=%d %v", id, pa.Payload, pa.Seq, err)
	}
	_, pb, err := Decode(c2s, rb)
	if err != nil || string(pb.Payload) != "two" {
		t.Fatalf("b %q %v", pb.Payload, err)
	}
}

func TestDirectionalKeysDoNotCross(t *testing.T) {
	c2s, s2c := testKeys()
	if bytes.Equal(c2s, s2c) {
		t.Fatal("c2s and s2c must differ")
	}
	raw, err := Encode(c2s, "nde1", Packet{Type: TypeBind, Seq: 1, Payload: []byte("c")})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := Decode(s2c, raw); err == nil {
		t.Fatal("s2c must not open c2s packet")
	}
}

func TestDecodeRejectsWrongKeyAndTamper(t *testing.T) {
	c2s, _ := testKeys()
	raw, err := Encode(c2s, "nde1", Packet{Type: TypeBind, Seq: 1, Payload: []byte("cookie")})
	if err != nil {
		t.Fatal(err)
	}
	other, _ := DerivePair(bytes.Repeat([]byte{1}, 32), []byte("cookie-16-bytes!"))
	if _, _, err := Decode(other, raw); err == nil {
		t.Fatal("wrong key")
	}
	tamper := append([]byte(nil), raw...)
	tamper[len(tamper)-1] ^= 0xff
	if _, _, err := Decode(c2s, tamper); err == nil {
		t.Fatal("tamper")
	}
}

func TestReplayWindowLossAndReorder(t *testing.T) {
	var w Window
	if !w.Accept(1) || !w.Accept(3) || !w.Accept(2) {
		t.Fatal("in-window reorder must be accepted")
	}
	if w.Accept(3) || w.Accept(1) {
		t.Fatal("duplicates must be rejected")
	}
	if w.Accept(0) {
		t.Fatal("seq 0 invalid")
	}
	if !w.Accept(10) {
		t.Fatal("forward jump")
	}
	if w.Accept(10) {
		t.Fatal("dup 10")
	}
}

func TestOpenerReplay(t *testing.T) {
	c2s, _ := testKeys()
	o := &Opener{Key: c2s}
	s := &Sealer{Key: c2s}
	r1, _ := s.Encode("nde1", Packet{Type: TypeData, Payload: []byte("a")})
	r2, _ := s.Encode("nde1", Packet{Type: TypeData, Payload: []byte("b")})
	if _, _, err := o.Decode(r2); err != nil {
		t.Fatal(err)
	}
	if _, _, err := o.Decode(r1); err != nil {
		t.Fatal("reorder")
	}
	if _, _, err := o.Decode(r2); err == nil {
		t.Fatal("replay")
	}
}

func TestWriterKeepsConcurrentWritesInSequenceOrder(t *testing.T) {
	c2s, _ := testKeys()
	w := &Writer{Key: c2s}
	const count = 256
	seqs := make([]uint64, 0, count)
	var gotMu sync.Mutex
	var wg sync.WaitGroup
	for i := 0; i < count; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := w.Write("nde1", Packet{Type: TypeData, Payload: []byte("x")}, func(raw []byte) (int, error) {
				_, pkt, err := Decode(c2s, raw)
				if err != nil {
					return 0, err
				}
				gotMu.Lock()
				seqs = append(seqs, pkt.Seq)
				gotMu.Unlock()
				return len(raw), nil
			})
			if err != nil {
				t.Errorf("write: %v", err)
			}
		}()
	}
	wg.Wait()
	if len(seqs) != count {
		t.Fatalf("writes=%d want %d", len(seqs), count)
	}
	for i, seq := range seqs {
		if want := uint64(i + 1); seq != want {
			t.Fatalf("write %d seq=%d want %d", i, seq, want)
		}
	}
}

func TestWriterClassifiesEncodeFailure(t *testing.T) {
	w := &Writer{}
	called := false
	_, err := w.Write("nde1", Packet{Type: TypeData}, func(raw []byte) (int, error) {
		called = true
		return len(raw), nil
	})
	if !errors.Is(err, ErrWriterEncode) {
		t.Fatalf("error=%v want ErrWriterEncode", err)
	}
	if called {
		t.Fatal("socket write called after encode failure")
	}
}

func TestPayloadSizes(t *testing.T) {
	c2s, _ := testKeys()
	for _, n := range []int{1200, 1400, MaxPayload} {
		p := Packet{Type: TypeData, Seq: uint64(n), MappingID: "m", FlowID: "flow1", PeerIP: net.IPv4(1, 2, 3, 4), PeerPort: 9, Payload: bytes.Repeat([]byte{1}, n)}
		raw, err := Encode(c2s, "nde1", p)
		if err != nil {
			t.Fatalf("%d: %v", n, err)
		}
		if n == MaxPayload && len(raw) > MaxUDPDatagram {
			t.Fatalf("encoded %d exceeds UDP max %d", len(raw), MaxUDPDatagram)
		}
		_, got, err := Decode(c2s, raw)
		if err != nil || len(got.Payload) != n {
			t.Fatalf("%d decode %d %v", n, len(got.Payload), err)
		}
	}
	p := Packet{Type: TypeData, Seq: 1, Payload: bytes.Repeat([]byte{1}, MaxPayload+1)}
	if _, err := Encode(c2s, "nde1", p); err == nil {
		t.Fatal("oversize must fail")
	}
}

func TestMaxPayloadFitsRealUDPSocket(t *testing.T) {
	c2s, _ := testKeys()
	id := string(bytes.Repeat([]byte{'n'}, maxID))
	p := Packet{
		Type: TypeData, Seq: 1,
		MappingID: string(bytes.Repeat([]byte{'m'}, maxMapID)),
		FlowID:    string(bytes.Repeat([]byte{'f'}, maxFlowID)),
		PeerIP:    net.ParseIP("2001:db8::1"),
		PeerPort:  65535,
		Payload:   bytes.Repeat([]byte{9}, MaxPayload),
	}
	raw, err := Encode(c2s, id, p)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) > MaxUDPDatagram {
		t.Fatalf("encoded %d > %d", len(raw), MaxUDPDatagram)
	}
	a, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	b, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	if _, err := b.WriteToUDP(raw, a.LocalAddr().(*net.UDPAddr)); err != nil {
		t.Fatalf("send max payload: %v", err)
	}
	_ = a.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, MaxUDPDatagram)
	n, _, err := a.ReadFromUDP(buf)
	if err != nil {
		t.Fatal(err)
	}
	_, got, err := Decode(c2s, buf[:n])
	if err != nil || len(got.Payload) != MaxPayload {
		t.Fatalf("recv %d %v", len(got.Payload), err)
	}
	p.Payload = bytes.Repeat([]byte{9}, MaxPayload+1)
	if _, err := Encode(c2s, id, p); err == nil {
		t.Fatal("max+1 must be rejected")
	}
}

func TestIndependentDatagramsSurviveLoss(t *testing.T) {
	c2s, _ := testKeys()
	s := &Sealer{Key: c2s}
	o := &Opener{Key: c2s}
	var kept [][]byte
	for i := 1; i <= 5; i++ {
		raw, err := s.Encode("nde1", Packet{Type: TypeData, Payload: []byte{byte(i)}})
		if err != nil {
			t.Fatal(err)
		}
		if i == 3 {
			continue
		}
		kept = append(kept, raw)
	}
	var got []byte
	for _, raw := range kept {
		_, p, err := o.Decode(raw)
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, p.Payload...)
	}
	if !bytes.Equal(got, []byte{1, 2, 4, 5}) {
		t.Fatalf("got %v", got)
	}
}
