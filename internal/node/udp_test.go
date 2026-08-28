package node

import (
	"net"
	"sync"
	"testing"
)

func TestCloseUDPLocalRemovesSocket(t *testing.T) {
	pc, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	key := "map|flow"
	locals := map[string]*udpLocal{key: {c: pc}}
	var mu sync.Mutex
	closeUDPLocal(&mu, locals, key)
	if _, ok := locals[key]; ok {
		t.Fatal("local entry should be removed")
	}
	dst := &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 9}
	if _, err := pc.WriteToUDP([]byte("x"), dst); err == nil {
		t.Fatal("closed UDP socket should reject writes")
	}
	closeUDPLocal(&mu, locals, key)
}
