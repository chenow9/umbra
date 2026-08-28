package wire

import (
	"bytes"
	"testing"
)

func TestControlJSONRoundtrip(t *testing.T) {
	var buf bytes.Buffer
	c := NewConn(&buf)
	if err := c.SendJSON("Hello", map[string]string{"node_id": "nde_1"}); err != nil {
		t.Fatal(err)
	}
	env, err := NewConn(&buf).Read()
	if err != nil {
		t.Fatal(err)
	}
	if env.Type != "Hello" {
		t.Fatalf("type %s", env.Type)
	}
	got, err := Decode[struct {
		NodeID string `json:"node_id"`
	}](env.Body)
	if err != nil {
		t.Fatal(err)
	}
	if got.NodeID != "nde_1" {
		t.Fatalf("body %+v", got)
	}
}

func TestStreamOpenAndDatagram(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteOpen(&buf, StreamOpen{MappingID: "map_1", Proto: "udp", PeerIP: "1.2.3.4", PeerPort: 9, Via: "public"}); err != nil {
		t.Fatal(err)
	}
	if err := WriteDatagram(&buf, []byte("ping")); err != nil {
		t.Fatal(err)
	}
	o, err := ReadOpen(&buf)
	if err != nil {
		t.Fatal(err)
	}
	if o.MappingID != "map_1" || o.Proto != "udp" || o.PeerPort != 9 {
		t.Fatalf("open %+v", o)
	}
	d, err := ReadDatagram(&buf)
	if err != nil {
		t.Fatal(err)
	}
	if string(d) != "ping" {
		t.Fatalf("dgram %q", d)
	}
}

func TestRejectOversizeDatagram(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteDatagram(&buf, make([]byte, maxDgram+1)); err == nil {
		t.Fatal("expected error")
	}
}
