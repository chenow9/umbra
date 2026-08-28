package control

import (
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"

	"umbra/internal/policy"
)

var (
	HTTPReadHeaderTimeout = 5 * time.Second
	HTTPReadTimeout       = 15 * time.Second
	HTTPWriteTimeout      = 30 * time.Second
	HTTPIdleTimeout       = 60 * time.Second
	HTTPMaxHeaderBytes    = 16 << 10
)

// HTTPBindNeedsTLS reports whether a management-plane bind must use TLS.
// Unix sockets and loopback TCP may stay plain HTTP. Unspecified or
// non-loopback TCP must not serve credentials in the clear.
func HTTPBindNeedsTLS(addr string) bool {
	if addr == "" {
		return false
	}
	if strings.HasPrefix(addr, "unix:") || strings.Contains(addr, "/") || strings.HasSuffix(addr, ".sock") {
		return false
	}
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}
	host = strings.Trim(host, "[]")
	if host == "" || host == "0.0.0.0" || host == "::" || host == "*" {
		return true
	}
	if strings.EqualFold(host, "localhost") {
		return false
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return true
	}
	return !ip.IsLoopback()
}

func CheckHTTPBind(addr string, hasTLS bool) error {
	if !HTTPBindNeedsTLS(addr) {
		return nil
	}
	if hasTLS {
		return nil
	}
	return fmt.Errorf("管理口 %s 不是回环或 Unix socket，必须提供 -http-tls-cert/-http-tls-key 或 -http-tls", addr)
}

func NewHTTPServer(h http.Handler) *http.Server {
	return &http.Server{
		Handler:           h,
		ReadHeaderTimeout: HTTPReadHeaderTimeout,
		ReadTimeout:       HTTPReadTimeout,
		WriteTimeout:      HTTPWriteTimeout,
		IdleTimeout:       HTTPIdleTimeout,
		MaxHeaderBytes:    HTTPMaxHeaderBytes,
		TLSConfig:         &tls.Config{MinVersion: tls.VersionTLS13},
	}
}

func (c *Console) cookieSecure(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	if strings.TrimSpace(c.TrustProxy) == "" {
		return false
	}
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		ip = r.RemoteAddr
	}
	if !policy.CidrAllowed(ip, c.TrustProxy) {
		return false
	}
	return strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}
