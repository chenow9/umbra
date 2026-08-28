// Package retry is shared reconnect backoff with jitter.
package retry

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"time"
)

const (
	Initial = time.Second
	Max     = 30 * time.Second
)

func jittered(d time.Duration) time.Duration {
	if d <= 0 {
		d = Initial
	}
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return d
	}
	n := binary.BigEndian.Uint64(b[:]) % (uint64(d) + 1)
	return d/2 + time.Duration(n)
}

func Sleep(ctx context.Context, backoff time.Duration) bool {
	t := time.NewTimer(jittered(backoff))
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

func Next(backoff time.Duration) time.Duration {
	if backoff <= 0 {
		return Initial
	}
	n := backoff * 2
	if n > Max {
		return Max
	}
	return n
}
