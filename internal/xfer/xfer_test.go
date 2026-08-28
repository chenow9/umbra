package xfer

import (
	"io"
	"net"
	"sync/atomic"
	"testing"
	"time"
)

func TestCopyBidirectionalCountsBothDirections(t *testing.T) {
	a, b := net.Pipe()
	c, d := net.Pipe()
	var in, out atomic.Int64
	done := make(chan struct{})
	go func() {
		CopyBidirectional(b, c, &in, &out)
		close(done)
	}()
	go func() {
		buf := make([]byte, 8)
		_, _ = d.Read(buf)
		_, _ = d.Write([]byte("pongpong"))
		_ = d.Close()
	}()
	if _, err := a.Write([]byte("pingping")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 8)
	if _, err := io.ReadFull(a, buf); err != nil {
		t.Fatal(err)
	}
	if string(buf) != "pongpong" {
		t.Fatalf("got %q", buf)
	}
	_ = a.Close()
	<-done
	if in.Load() != 8 {
		t.Fatalf("in=%d", in.Load())
	}
	if out.Load() != 8 {
		t.Fatalf("out=%d", out.Load())
	}
}

func TestCopyBidirectionalUnblocksWhenOneSideCloses(t *testing.T) {
	a, b := net.Pipe()
	c, d := net.Pipe()
	done := make(chan struct{})
	go func() {
		CopyBidirectional(b, c, nil, nil)
		close(done)
	}()
	if _, err := a.Write([]byte("x")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 1)
	if _, err := d.Read(buf); err != nil {
		t.Fatal(err)
	}
	_ = a.Close()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("copy stuck after one side closed")
	}
	_ = d.Close()
}

func TestCopyBidirectionalReplyAfterFIN(t *testing.T) {
	lnSrc, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer lnSrc.Close()
	lnDst, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer lnDst.Close()

	srcCh := make(chan net.Conn, 1)
	dstCh := make(chan net.Conn, 1)
	go func() {
		c, err := lnSrc.Accept()
		if err != nil {
			return
		}
		srcCh <- c
	}()
	go func() {
		c, err := lnDst.Accept()
		if err != nil {
			return
		}
		dstCh <- c
	}()
	client, err := net.Dial("tcp", lnSrc.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	backend, err := net.Dial("tcp", lnDst.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	src := <-srcCh
	dst := <-dstCh
	defer src.Close()
	defer dst.Close()

	done := make(chan struct{})
	go func() {
		CopyBidirectional(dst, src, nil, nil)
		close(done)
	}()

	backendErr := make(chan error, 1)
	go func() {
		buf := make([]byte, 4)
		if _, err := io.ReadFull(backend, buf); err != nil {
			backendErr <- err
			return
		}
		if string(buf) != "ping" {
			backendErr <- io.ErrUnexpectedEOF
			return
		}
		_, _ = io.Copy(io.Discard, backend)
		if _, err := backend.Write([]byte("pong")); err != nil {
			backendErr <- err
			return
		}
		_ = backend.(*net.TCPConn).CloseWrite()
		backendErr <- nil
	}()

	if _, err := client.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	if err := client.(*net.TCPConn).CloseWrite(); err != nil {
		t.Fatal(err)
	}
	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	got := make([]byte, 4)
	if _, err := io.ReadFull(client, got); err != nil {
		t.Fatalf("client got no reply after FIN: %v", err)
	}
	if string(got) != "pong" {
		t.Fatalf("got %q", got)
	}
	select {
	case err := <-backendErr:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("backend stalled")
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("copy did not finish after both FINs")
	}
}

func TestCopyBidirectionalHardErrorClosesBoth(t *testing.T) {
	lnSrc, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer lnSrc.Close()
	lnDst, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer lnDst.Close()
	srcCh := make(chan net.Conn, 1)
	dstCh := make(chan net.Conn, 1)
	go func() { c, _ := lnSrc.Accept(); srcCh <- c }()
	go func() { c, _ := lnDst.Accept(); dstCh <- c }()
	client, err := net.Dial("tcp", lnSrc.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	backend, err := net.Dial("tcp", lnDst.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	src := <-srcCh
	dst := <-dstCh

	done := make(chan struct{})
	go func() {
		CopyBidirectional(dst, src, nil, nil)
		close(done)
	}()
	if tcp, ok := client.(*net.TCPConn); ok {
		_ = tcp.SetLinger(0)
	}
	_ = client.Close()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("hard close did not unblock copy")
	}
	_ = backend.Close()
}

func TestCopyBidirectionalHangAfterFIN(t *testing.T) {
	old := ClosingTimeout
	ClosingTimeout = 80 * time.Millisecond
	t.Cleanup(func() { ClosingTimeout = old })

	lnSrc, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer lnSrc.Close()
	lnDst, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer lnDst.Close()
	srcCh := make(chan net.Conn, 1)
	dstCh := make(chan net.Conn, 1)
	go func() { c, _ := lnSrc.Accept(); srcCh <- c }()
	go func() { c, _ := lnDst.Accept(); dstCh <- c }()
	client, err := net.Dial("tcp", lnSrc.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	backend, err := net.Dial("tcp", lnDst.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	src := <-srcCh
	dst := <-dstCh
	done := make(chan struct{})
	go func() {
		CopyBidirectional(dst, src, nil, nil)
		close(done)
	}()
	if _, err := client.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 4)
	if _, err := io.ReadFull(backend, buf); err != nil {
		t.Fatal(err)
	}
	if err := client.(*net.TCPConn).CloseWrite(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("backend hang after FIN must be bounded by ClosingTimeout")
	}
}
