package muxcfg

import (
	"io"
	"time"

	"github.com/hashicorp/yamux"
)

// StreamWindow is the yamux per-stream receive window used by the gateway,
// nodes and visitor clients alike.
const StreamWindow = 2 * 1024 * 1024

func Config() *yamux.Config {
	c := yamux.DefaultConfig()
	c.LogOutput = io.Discard
	c.EnableKeepAlive = true
	c.KeepAliveInterval = 30 * time.Second
	c.ConnectionWriteTimeout = 10 * time.Second
	// Per-stream receive window. Throughput on one stream is bounded by
	// window/RTT: 256 KiB capped a single connection near 20 Mbit/s at
	// 100 ms, which is common between a home node and a cloud gateway.
	// 2 MiB lifts that to ~160 Mbit/s. yamux grows a stream's buffer only
	// when the reader falls behind, so idle streams stay small.
	c.MaxStreamWindowSize = StreamWindow
	c.StreamOpenTimeout = 8 * time.Second
	// 256 saturates at dial -par=256: node accept queue RSTs extra SYNs.
	c.AcceptBacklog = 4096
	return c
}
