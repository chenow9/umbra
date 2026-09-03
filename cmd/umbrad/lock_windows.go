//go:build windows

package main

import (
	"os"
	"os/exec"
)

// LockFileEx 区域锁不随句柄继承。Windows 热升级用 control.handoff
// 让子进程在父进程释放后立刻抢锁；交接完成前其它进程不得加锁。
func attachInheritedLock(cmd *exec.Cmd, f *os.File) {}

func lockHandoffNeedsRelease() bool { return true }
