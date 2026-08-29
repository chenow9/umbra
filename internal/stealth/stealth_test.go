//go:build linux

package stealth

import (
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestNewFallsBackWhenNetfilterDenied(t *testing.T) {
	e := New(true)
	if e == nil {
		t.Fatal("nil engine")
	}
	if e.Mode() != "nft" && e.Mode() != "userspace" {
		t.Fatalf("mode %s", e.Mode())
	}
	e.SetSPA(Port{Proto: "tcp", Port: 9}, true)
	e.Knock(Port{Proto: "tcp", Port: 9}, "127.0.0.1", 50*time.Millisecond)
	e.Clear()
}

func TestUnshareNetnsCanLoadTable(t *testing.T) {
	if err := unix.Unshare(unix.CLONE_NEWNET); err != nil {
		t.Skip(err)
	}
	e := New(true)
	t.Log("mode", e.Mode(), "kernel", e.Kernel())
}
