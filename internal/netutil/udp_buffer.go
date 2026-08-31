package netutil

import (
	"os"
	"strconv"
)

const DefaultUDPReadBuffer = 512 << 10

// UDPReadBuffer returns the requested per-socket UDP receive buffer in bytes.
// An unset, invalid, or non-positive UMBRA_UDP_READ_BUFFER uses the default.
func UDPReadBuffer() int {
	raw := os.Getenv("UMBRA_UDP_READ_BUFFER")
	if raw == "" {
		return DefaultUDPReadBuffer
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return DefaultUDPReadBuffer
	}
	return n
}

// SetUDPReadBuffer requests the configured receive buffer when conn exposes
// the UDP SetReadBuffer operation. Test packet connections and other custom
// implementations that do not expose it are left unchanged.
func SetUDPReadBuffer(conn any) error {
	setter, ok := conn.(interface{ SetReadBuffer(int) error })
	if !ok {
		return nil
	}
	return setter.SetReadBuffer(UDPReadBuffer())
}
