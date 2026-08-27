//go:build !unix

package netutil

import "net"

func Listen(network, addr string) (net.Listener, error) {
	return net.Listen(network, addr)
}

func ListenPacket(network, addr string) (net.PacketConn, error) {
	return net.ListenPacket(network, addr)
}
