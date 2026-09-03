//go:build !windows

package control

import (
	"os"
	"syscall"
)

func lockFileExclusive(f *os.File, blocking bool) error {
	how := syscall.LOCK_EX
	if !blocking {
		how |= syscall.LOCK_NB
	}
	return syscall.Flock(int(f.Fd()), how)
}
