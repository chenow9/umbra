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

// limitChunk bounds how many bytes one reservation covers so a slow mapping
// releases data in small, evenly paced pieces instead of one long stall.
const limitChunk = 16 << 10

type rwLimit struct {
	io.ReadWriteCloser
	reserve func(int) time.Duration
}

// WithLimit shapes writes to rw. reserve debits n bytes and returns how
// long to wait before sending them; Write sleeps for that long rather than
// failing, so a rate limit throttles the stream instead of tearing it down.
func WithLimit(rw io.ReadWriteCloser, reserve func(int) time.Duration) io.ReadWriteCloser {
	if reserve == nil {
		return rw
	}
	return rwLimit{ReadWriteCloser: rw, reserve: reserve}
}

func (r rwLimit) Write(p []byte) (int, error) {
	written := 0
	for len(p) > 0 {
		chunk := p
		if len(chunk) > limitChunk {
			chunk = p[:limitChunk]
		}
		if wait := r.reserve(len(chunk)); wait > 0 {
			time.Sleep(wait)
		}
		n, err := r.ReadWriteCloser.Write(chunk)
		written += n
		if err != nil {
			return written, err
		}
		if n != len(chunk) {
			return written, fmt.Errorf("short write")
		}
		p = p[n:]
	}
	return written, nil
}

func (r rwLimit) CloseWrite() error {
	if x, ok := r.ReadWriteCloser.(closeWriter); ok {
		return x.CloseWrite()
	}
	return r.Close()
}
