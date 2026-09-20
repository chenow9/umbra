package control

import (
	"fmt"
	"net"
	"strings"
	"unicode"
)

func validNodeName(name string) error {
	name = strings.TrimSpace(name)
	if err := checkNameComment(name, ""); err != nil {
		return err
	}
	if !nodeNameCharsetOK(name) {
		return fmt.Errorf("名称无效")
	}
	return nil
}

func checkNodeIdentity(name, comment string) error {
	if err := validNodeName(name); err != nil {
		return err
	}
	return checkNameComment(name, comment)
}

func nodeNameCharsetOK(name string) bool {
	hasAlnum := false
	for _, r := range name {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			hasAlnum = true
		case r == ' ' || r == '.' || r == '_' || r == '-':
		default:
			return false
		}
	}
	return hasAlnum
}

func validLocalHost(host string) bool {
	host = strings.TrimSpace(host)
	if host == "" || len(host) > 253 {
		return false
	}
	if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		return net.ParseIP(host[1:len(host)-1]) != nil
	}
	if net.ParseIP(host) != nil {
		return true
	}
	return validHostname(host)
}

func validHostname(host string) bool {
	host = strings.TrimSuffix(host, ".")
	if host == "" || len(host) > 253 {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if !validHostLabel(label) {
			return false
		}
	}
	return true
}

func validHostLabel(label string) bool {
	n := len(label)
	if n < 1 || n > 63 {
		return false
	}
	for i := 0; i < n; i++ {
		c := label[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '_':
		case c == '-':
			if i == 0 || i == n-1 {
				return false
			}
		default:
			return false
		}
	}
	return true
}
