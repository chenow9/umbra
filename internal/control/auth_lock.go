package control

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	lockFDEnv      = "UMBRA_LOCK_FD"
	lockHandoffEnv = "UMBRA_LOCK_HANDOFF"
)

func handoffPath(persist string) string {
	return filepath.Join(filepath.Dir(persist), "control.handoff")
}

func WriteLockHandoff(persist, nonce string) error {
	nonce = strings.TrimSpace(nonce)
	if nonce == "" {
		return fmt.Errorf("empty handoff nonce")
	}
	return writeAtomic(handoffPath(persist), []byte(nonce+"\n"), 0o600)
}

func ClearLockHandoff(persist string) {
	_ = os.Remove(handoffPath(persist))
}

func lockHandoffNonce(persist string) string {
	raw, err := os.ReadFile(handoffPath(persist))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}

func AcquireControlLock(persist string) (*os.File, error) {
	if lockHandoffNonce(persist) != "" {
		return nil, fmt.Errorf("热升级进行中，无法锁定 tls-dir")
	}
	f, err := tryControlLock(persist, false)
	if err != nil {
		return nil, fmt.Errorf("无法锁定 tls-dir，已有 umbrad 在运行: %w", err)
	}
	return f, nil
}

func AcquireControlLockHandoff(persist, wantNonce string, timeout time.Duration) (*os.File, error) {
	wantNonce = strings.TrimSpace(wantNonce)
	if wantNonce == "" {
		return nil, fmt.Errorf("missing lock handoff nonce")
	}
	deadline := time.Now().Add(timeout)
	var last error
	for {
		got := lockHandoffNonce(persist)
		if got == "" {
			return nil, fmt.Errorf("热升级交接已取消")
		}
		if got != wantNonce {
			return nil, fmt.Errorf("热升级交接无效")
		}
		f, err := tryControlLock(persist, false)
		if err == nil {
			ClearLockHandoff(persist)
			return f, nil
		}
		last = err
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("等待接管 tls-dir 锁超时: %w", last)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func WaitLockHandoffCleared(persist string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		if lockHandoffNonce(persist) == "" {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("等待子进程接管锁超时")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func OpenControlLock(persist string) (*os.File, error) {
	if os.Getenv("UMBRA_UPGRADED") == "1" {
		if f := AdoptControlLockFromEnv(); f != nil {
			ClearLockHandoff(persist)
			return f, nil
		}
		if nonce := strings.TrimSpace(os.Getenv(lockHandoffEnv)); nonce != "" {
			return AcquireControlLockHandoff(persist, nonce, 10*time.Second)
		}
	}
	return AcquireControlLock(persist)
}

func AdoptControlLockFromEnv() *os.File {
	if os.Getenv("UMBRA_UPGRADED") != "1" {
		return nil
	}
	v := os.Getenv(lockFDEnv)
	if v == "" {
		return nil
	}
	u, err := strconv.ParseUint(v, 10, 64)
	if err != nil || u == 0 {
		return nil
	}
	return os.NewFile(uintptr(u), "control.lock")
}

func (c *Console) AttachLock(f *os.File) {
	c.lockFile = f
}

func (c *Console) LockFile() *os.File {
	return c.lockFile
}

func (c *Console) HoldLock() error {
	f, err := AcquireControlLock(c.Persist)
	if err != nil {
		return err
	}
	c.lockFile = f
	return nil
}

func (c *Console) Start() {
	c.mu.Lock()
	if c.started {
		c.mu.Unlock()
		return
	}
	c.started = true
	c.stopCh = make(chan struct{})
	c.bgWG.Add(1)
	c.mu.Unlock()
	go func() {
		defer c.bgWG.Done()
		c.sampleLoop()
	}()
}

func (c *Console) BeginDrain() {
	if c.draining.CompareAndSwap(false, true) {
		close(c.drainCh)
	}
}

func (c *Console) ResumeFromDrain() {
	c.mu.Lock()
	c.drainCh = make(chan struct{})
	c.mu.Unlock()
	c.draining.Store(false)
}

func (c *Console) WaitHTTP(d time.Duration) bool {
	done := make(chan struct{})
	go func() {
		c.httpWG.Wait()
		close(done)
	}()
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-done:
		return c.httpActive.Load() == 0
	case <-timer.C:
		return c.httpActive.Load() == 0
	}
}

func (c *Console) DrainHTTP(timeout time.Duration) bool {
	c.BeginDrain()
	if c.WaitHTTP(timeout) {
		return true
	}
	c.ResumeFromDrain()
	return false
}

func (c *Console) SetHTTPStall(fn func()) {
	if fn == nil {
		fn = func() {}
	}
	c.httpStall.Store(fn)
}

func (c *Console) StopBackground() {
	c.mu.Lock()
	if !c.started || c.stopped {
		c.mu.Unlock()
		return
	}
	c.stopped = true
	if c.stopCh != nil {
		close(c.stopCh)
	}
	c.mu.Unlock()
	c.bgWG.Wait()
}

func (c *Console) PersistNow() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.save()
}
