//go:build unix

package main

import (
	"os"
	"os/exec"
)

func attachInheritedLock(cmd *exec.Cmd, f *os.File) {
	if f == nil {
		return
	}
	cmd.ExtraFiles = append(cmd.ExtraFiles, f)
	cmd.Env = append(cmd.Env, "UMBRA_LOCK_FD=3")
}

func lockHandoffNeedsRelease() bool { return false }
