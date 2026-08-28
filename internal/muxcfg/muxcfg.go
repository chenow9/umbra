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
	c.AcceptBacklog = 32
	return c
}
