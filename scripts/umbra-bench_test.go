package main

import (
	"io"
	"net"
	"sync/atomic"
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

func startTCPEcho(t *testing.T, delay time.Duration) (addr string, closeFn func()) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
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
				buf := make([]byte, 64*1024)
				for {
					n, err := c.Read(buf)
					if n > 0 {
						if delay > 0 {
							time.Sleep(delay)
						}
						if _, werr := c.Write(buf[:n]); werr != nil {
							return
						}
					}
					if err != nil {
						return
					}
				}
			}(c)
		}
	}()
	return ln.Addr().String(), func() { _ = ln.Close(); <-done }
}

func TestRRHoldOffsetSpreads(t *testing.T) {
	if g := rrHoldOffset(0, 100, time.Second); g != 0 {
		t.Fatalf("first offset %s", g)
	}
	if g := rrHoldOffset(99, 100, time.Second); g != 990*time.Millisecond {
		t.Fatalf("last offset %s", g)
	}
	if g := rrHoldOffset(5, 10, 0); g != 0 {
		t.Fatalf("interval 0 offset %s", g)
	}
}

func TestRRSkipTicksDoesNotCatchUp(t *testing.T) {
	start := time.Unix(0, 0)
	now := start.Add(250 * time.Millisecond)
	next := rrSkipTicks(start, 100*time.Millisecond, now)
	if want := start.Add(300 * time.Millisecond); !next.Equal(want) {
		t.Fatalf("next=%s want %s", next, want)
	}
}

func TestRRNextDelayStopsAtHoldDeadline(t *testing.T) {
	start := time.Unix(0, 0)
	wait, again := rrNextDelay(start, start.Add(450*time.Millisecond), start.Add(500*time.Millisecond), 500*time.Millisecond)
	if wait != 50*time.Millisecond || again {
		t.Fatalf("wait=%s again=%v, want 50ms false", wait, again)
	}

	wait, again = rrNextDelay(start, start.Add(100*time.Millisecond), start.Add(time.Second), 500*time.Millisecond)
	if wait != 400*time.Millisecond || !again {
		t.Fatalf("wait=%s again=%v, want 400ms true", wait, again)
	}
}

func TestTCPRRSteadySmall(t *testing.T) {
	addr, closeFn := startTCPEcho(t, 0)
	defer closeFn()
	msg := make([]byte, 16)
	res, code := runTCPRR(addr, 20, 20, msg, 500*time.Millisecond, 200*time.Millisecond, 50*time.Millisecond, 200*time.Millisecond)
	if code != 0 {
		t.Fatalf("code=%d res=%+v", code, res)
	}
	if res.FirstEchoOK != 20 || res.AliveAtDeadline != 20 || res.FailedDuringHold != 0 || res.FinalProbeOK != 20 {
		t.Fatalf("steady fields: %+v", res)
	}
}

func TestTCPRRHoldDeadlineTimeoutIsAlive(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				buf := make([]byte, 8)
				nread := 0
				for {
					if _, err := io.ReadFull(c, buf); err != nil {
						return
					}
					nread++
					if nread > 1 {
						time.Sleep(time.Second)
					}
					if _, err := c.Write(buf); err != nil {
						return
					}
				}
			}(c)
		}
	}()
	msg := make([]byte, 8)
	res, code := runTCPRR(ln.Addr().String(), 1, 1, msg, 5*time.Second, 80*time.Millisecond, time.Second, 2*time.Second)
	if res.FirstEchoOK != 1 {
		t.Fatalf("firstEchoOK=%d", res.FirstEchoOK)
	}
	if res.FailedDuringHold != 0 || res.AliveAtDeadline != 1 {
		t.Fatalf("deadline timeout must not fail the conn: %+v", res)
	}
	if res.FinalProbeOK != 1 || code != 0 {
		t.Fatalf("final probe: code=%d res=%+v", code, res)
	}
}

func TestTCPRRIntervalDoesNotStorm(t *testing.T) {
	var peak atomic.Int64
	var inflight atomic.Int64
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				buf := make([]byte, 16)
				for {
					n, err := c.Read(buf)
					if n > 0 {
						cur := inflight.Add(1)
						for {
							p := peak.Load()
							if cur <= p || peak.CompareAndSwap(p, cur) {
								break
							}
						}
						time.Sleep(20 * time.Millisecond)
						_, _ = c.Write(buf[:n])
						inflight.Add(-1)
					}
					if err != nil {
						return
					}
				}
			}(c)
		}
	}()
	msg := make([]byte, 16)
	const n = 30
	res, code := runTCPRR(ln.Addr().String(), n, n, msg, time.Second, 200*time.Millisecond, 200*time.Millisecond, 200*time.Millisecond)
	if code != 0 {
		t.Fatalf("code=%d res=%+v", code, res)
	}
	if res.HoldAttempts > int64(n)*3 {
		t.Fatalf("holdAttempts=%d, expected stagger not a storm", res.HoldAttempts)
	}
	if peak.Load() > int64(n) {
		t.Fatalf("in-flight peak %d", peak.Load())
	}
}
