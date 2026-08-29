package muxcfg

import (
	"io"
	"time"

	"github.com/hashicorp/yamux"
)

func Config() *yamux.Config {
	c := yamux.DefaultConfig()
	c.LogOutput = io.Discard
	c.EnableKeepAlive = true
	c.KeepAliveInterval = 30 * time.Second
	c.ConnectionWriteTimeout = 10 * time.Second
	c.MaxStreamWindowSize = 256 * 1024
	c.StreamOpenTimeout = 8 * time.Second
	// 256 saturates at dial -par=256: node accept queue RSTs extra SYNs.
	c.AcceptBacklog = 4096
	return c
}
