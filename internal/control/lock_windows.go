//go:build windows

package control

import (
	"os"

	"golang.org/x/sys/windows"
)

func lockFileExclusive(f *os.File, blocking bool) error {
	flags := uint32(windows.LOCKFILE_EXCLUSIVE_LOCK)
	if !blocking {
		flags |= windows.LOCKFILE_FAIL_IMMEDIATELY
	}
	ol := new(windows.Overlapped)
	const maxUint32 = ^uint32(0)
	return windows.LockFileEx(windows.Handle(f.Fd()), flags, 0, maxUint32, maxUint32, ol)
}
