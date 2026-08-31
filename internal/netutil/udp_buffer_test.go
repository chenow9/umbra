package netutil

import (
	"errors"
	"testing"
)

type readBufferRecorder struct {
	n   int
	err error
}

func (r *readBufferRecorder) SetReadBuffer(n int) error {
	r.n = n
	return r.err
}

func TestUDPReadBuffer(t *testing.T) {
	if DefaultUDPReadBuffer != 512<<10 {
		t.Fatalf("default=%d want 512 KiB", DefaultUDPReadBuffer)
	}
	t.Setenv("UMBRA_UDP_READ_BUFFER", "")
	if got := UDPReadBuffer(); got != DefaultUDPReadBuffer {
		t.Fatalf("default=%d want %d", got, DefaultUDPReadBuffer)
	}
	t.Setenv("UMBRA_UDP_READ_BUFFER", "8388608")
	if got := UDPReadBuffer(); got != 8<<20 {
		t.Fatalf("configured=%d want %d", got, 8<<20)
	}
	for _, value := range []string{"0", "-1", "bad"} {
		t.Setenv("UMBRA_UDP_READ_BUFFER", value)
		if got := UDPReadBuffer(); got != DefaultUDPReadBuffer {
			t.Fatalf("value %q got %d want default %d", value, got, DefaultUDPReadBuffer)
		}
	}
}

func TestSetUDPReadBuffer(t *testing.T) {
	t.Setenv("UMBRA_UDP_READ_BUFFER", "1048576")
	recorder := &readBufferRecorder{}
	if err := SetUDPReadBuffer(recorder); err != nil {
		t.Fatal(err)
	}
	if recorder.n != 1<<20 {
		t.Fatalf("buffer=%d want %d", recorder.n, 1<<20)
	}
	want := errors.New("set buffer")
	recorder.err = want
	if err := SetUDPReadBuffer(recorder); !errors.Is(err, want) {
		t.Fatalf("error=%v want %v", err, want)
	}
	if err := SetUDPReadBuffer(struct{}{}); err != nil {
		t.Fatalf("unsupported connection: %v", err)
	}
}
