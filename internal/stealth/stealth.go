//go:build linux

package stealth

import (
	"encoding/binary"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/google/nftables"
	"github.com/google/nftables/expr"
	"golang.org/x/sys/unix"
)

type Port struct {
	Proto string // tcp | udp
	Port  uint16
}

type Engine struct {
	mu      sync.Mutex
	conn    *nftables.Conn
	table   *nftables.Table
	chain   *nftables.Chain
	ok      bool
	mode    string
	dropped map[string]Port
	open    map[string]time.Time
}

func New(enable bool) *Engine {
	e := &Engine{dropped: map[string]Port{}, open: map[string]time.Time{}, mode: "userspace"}
	if !enable {
		return e
	}
	c, err := nftables.New()
	if err != nil {
		log.Printf("stealth: nftables %v — 退回用户态丢包", err)
		return e
	}
	e.conn = c
	e.table = c.AddTable(&nftables.Table{Family: nftables.TableFamilyIPv4, Name: "umbra"})
	e.chain = c.AddChain(&nftables.Chain{
		Name:     "input",
		Table:    e.table,
		Type:     nftables.ChainTypeFilter,
		Hooknum:  nftables.ChainHookInput,
		Priority: nftables.ChainPriorityFilter,
	})
	if err := c.Flush(); err != nil {
		log.Printf("stealth: 无法安装内核表 %v — 退回用户态丢包", err)
		e.conn = nil
		return e
	}
	e.ok = true
	e.mode = "nft"
	log.Printf("stealth: 内核丢弃已启用 (table inet/ip umbra)")
	return e
}

func (e *Engine) Mode() string {
	if e == nil {
		return "off"
	}
	return e.mode
}

func (e *Engine) Kernel() bool { return e != nil && e.ok }

func key(p Port) string { return fmt.Sprintf("%s/%d", p.Proto, p.Port) }

func (e *Engine) SetSPA(p Port, drop bool) {
	if e == nil {
		return
	}
	e.mu.Lock()
	if drop {
		delete(e.open, key(p))
		e.dropped[key(p)] = p
	} else {
		delete(e.dropped, key(p))
	}
	e.mu.Unlock()
	e.rebuild()
}

func (e *Engine) Knock(p Port, ttl time.Duration) {
	if e == nil {
		return
	}
	e.mu.Lock()
	e.open[key(p)] = time.Now().Add(ttl)
	e.mu.Unlock()
	e.rebuild()
	time.AfterFunc(ttl+50*time.Millisecond, func() {
		e.mu.Lock()
		until, ok := e.open[key(p)]
		if ok && time.Now().After(until.Add(-time.Millisecond)) {
			delete(e.open, key(p))
		}
		e.mu.Unlock()
		e.rebuild()
	})
}

func (e *Engine) Clear() {
	if e == nil || !e.ok {
		return
	}
	e.mu.Lock()
	e.dropped = map[string]Port{}
	e.open = map[string]time.Time{}
	e.mu.Unlock()
	e.conn.FlushChain(e.chain)
	_ = e.conn.Flush()
}

func (e *Engine) rebuild() {
	if e == nil || !e.ok {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.conn.FlushChain(e.chain)
	now := time.Now()
	for k, p := range e.dropped {
		if until, ok := e.open[k]; ok && now.Before(until) {
			continue
		}
		e.conn.AddRule(&nftables.Rule{
			Table: e.table,
			Chain: e.chain,
			Exprs: dropExprs(p),
		})
	}
	if err := e.conn.Flush(); err != nil {
		log.Printf("stealth: 刷新规则失败 %v", err)
	}
}

func dropExprs(p Port) []expr.Any {
	proto := byte(unix.IPPROTO_TCP)
	if p.Proto == "udp" {
		proto = unix.IPPROTO_UDP
	}
	port := make([]byte, 2)
	binary.BigEndian.PutUint16(port, p.Port)
	return []expr.Any{
		&expr.Meta{Key: expr.MetaKeyL4PROTO, Register: 1},
		&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: []byte{proto}},
		&expr.Payload{DestRegister: 1, Base: expr.PayloadBaseTransportHeader, Offset: 2, Len: 2},
		&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: port},
		&expr.Verdict{Kind: expr.VerdictDrop},
	}
}
