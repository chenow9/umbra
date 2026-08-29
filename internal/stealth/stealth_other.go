//go:build !linux

package stealth

import "time"

type Port struct {
	Proto string
	Port  uint16
}

type Engine struct{ mode string }

func New(enable bool) *Engine { return &Engine{mode: "userspace"} }
func (e *Engine) Mode() string {
	if e == nil {
		return "off"
	}
	return e.mode
}
func (e *Engine) Kernel() bool                               { return false }
func (e *Engine) SetSPA(p Port, drop bool)                   {}
func (e *Engine) Knock(p Port, ip string, ttl time.Duration) {}
func (e *Engine) Clear()                                     {}
