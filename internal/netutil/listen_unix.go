//go:build unix

package netutil

import (
	"context"
	"net"
	"syscall"

	"golang.org/x/sys/unix"
)

func reuse() func(network, address string, c syscall.RawConn) error {
	return func(network, address string, c syscall.RawConn) error {
		var sockErr error
		err := c.Control(func(fd uintptr) {
			sockErr = unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_REUSEADDR, 1)
		})
		if err != nil {
			return err
		}
		return sockErr
	}
}

func Listen(network, addr string) (net.Listener, error) {
	cfg := net.ListenConfig{Control: reuse()}
	return cfg.Listen(context.Background(), network, addr)
}

func ListenPacket(network, addr string) (net.PacketConn, error) {
	cfg := net.ListenConfig{Control: reuse()}
	return cfg.ListenPacket(context.Background(), network, addr)
}
