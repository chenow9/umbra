package main

import (
	"io"
	"net"
	"testing"
	"time"
)

func TestHoldOpEndedOnlyTimeout(t *testing.T) {
	deadline := time.Now().Add(8 * time.Second)
	timeout := 30 * time.Second
	to := 8 * time.Second
	if holdOpEnded(deadline, timeout, to, io.ErrUnexpectedEOF) {
		t.Fatal("UnexpectedEOF must not count as hold deadline")
	}
	if holdOpEnded(deadline, timeout, to, io.EOF) {
		t.Fatal("EOF must not count as hold deadline")
	}
	if holdOpEnded(deadline, timeout, to, nil) {
		t.Fatal("nil error is not hold deadline")
	}
}

func TestStreamUnexpectedEOFIsRxErr(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				if _, err := c.Write([]byte{1}); err != nil {
					return
				}
				if tc, ok := c.(*net.TCPConn); ok {
					_ = tc.CloseWrite()
				}
				_, _ = io.Copy(io.Discard, c)
			}(c)
		}
	}()

	chunk := make([]byte, 1024)
	res, code := runTCPStream(ln.Addr().String(), 1, 1, chunk, 30*time.Second, 400*time.Millisecond)
	_ = ln.Close()
	<-done

	if res.RxErr == 0 {
		t.Fatalf("rxErr=0, expected backend CloseWrite mid-hold to count as error: %+v", res)
	}
	if res.AliveAtDeadline != 0 {
		t.Fatalf("aliveAtDeadline=%d, want 0", res.AliveAtDeadline)
	}
	if code == 0 {
		t.Fatal("exit code 0; mid-hold UnexpectedEOF should fail the run")
	}
}
