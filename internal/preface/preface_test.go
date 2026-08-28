package preface

import (
	"bytes"
	"testing"
)

func TestPrefaceRoundtrip(t *testing.T) {
	var buf bytes.Buffer
	if err := Write(&buf, KindNode, "umbra_boot_abc"); err != nil {
		t.Fatal(err)
	}
	kind, cred, err := Read(&buf)
	if err != nil {
		t.Fatal(err)
	}
	if kind != KindNode || cred != "umbra_boot_abc" {
		t.Fatalf("%d %q", kind, cred)
	}
}

func TestPrefaceRejectsOversize(t *testing.T) {
	if err := Write(ioDiscard{}, KindVisit, string(make([]byte, 300))); err == nil {
		t.Fatal("expected error")
	}
}

type ioDiscard struct{}

func (ioDiscard) Write(p []byte) (int, error) { return len(p), nil }
