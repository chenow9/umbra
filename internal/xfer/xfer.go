package xfer

import (
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// ClosingTimeout is how long a clean half-close waits for the reverse
// direction before tearing both sides down.
var ClosingTimeout = 30 * time.Second

type countWriter struct {
	w io.Writer
	n *atomic.Int64
}

func (c countWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	if n > 0 && c.n != nil {
		c.n.Add(int64(n))
	}
	return n, err
}

func isCleanCopyEnd(err error) bool {
	return err == nil || errors.Is(err, io.EOF)
}

func isHardCopyErr(err error) bool {
	if isCleanCopyEnd(err) {
		return false
	}
	if errors.Is(err, net.ErrClosed) {
		return true
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return true
	}
	return true
}

// CopyBidirectional copies both directions. A clean EOF only CloseWrite's
// that side so the peer can still reply; RST, timeout, or other hard
// errors close both ends. After the first clean EOF a closing timer
// bounds how long the reverse direction may run.
func CopyBidirectional(dst, src io.ReadWriteCloser, in, out *atomic.Int64) {
	var once sync.Once
	hardClose := func() {
		once.Do(func() {
			_ = dst.Close()
			_ = src.Close()
		})
	}
	done := make(chan error, 2)
	copyOne := func(w, r io.ReadWriteCloser, n *atomic.Int64) {
		_, err := io.Copy(countWriter{w: w, n: n}, r)
		if isCleanCopyEnd(err) {
			_ = closeWrite(w)
		} else if isHardCopyErr(err) {
			hardClose()
		}
		done <- err
	}
	go copyOne(dst, src, in)
	go copyOne(src, dst, out)

	first := <-done
	if !isCleanCopyEnd(first) {
		hardClose()
		<-done
		return
	}
	timer := time.NewTimer(ClosingTimeout)
	defer timer.Stop()
	select {
	case <-done:
		hardClose()
	case <-timer.C:
		hardClose()
		<-done
	}
}

type closeWriter interface {
	CloseWrite() error
}

func closeWrite(c io.ReadWriteCloser) error {
	if x, ok := c.(closeWriter); ok {
		return x.CloseWrite()
	}
	// yamux Stream.Close is a half-close (sends FIN, reads still work).
	return c.Close()
}

type rwLimit struct {
	io.ReadWriteCloser
	take func(int) bool
}

func WithLimit(rw io.ReadWriteCloser, take func(int) bool) io.ReadWriteCloser {
	if take == nil {
		return rw
	}
	return rwLimit{ReadWriteCloser: rw, take: take}
}

func (r rwLimit) Write(p []byte) (int, error) {
	if r.take != nil && !r.take(len(p)) {
		return 0, fmt.Errorf("rate limit")
	}
	return r.ReadWriteCloser.Write(p)
}

func (r rwLimit) CloseWrite() error {
	if x, ok := r.ReadWriteCloser.(closeWriter); ok {
		return x.CloseWrite()
	}
	return r.Close()
}
