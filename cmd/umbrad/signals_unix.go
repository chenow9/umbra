//go:build unix

package main

import (
	"os"
	"syscall"
)

func watchSignals() []os.Signal {
	return []os.Signal{syscall.SIGINT, syscall.SIGTERM, syscall.SIGUSR2}
}

func isUpgrade(sig os.Signal) bool { return sig == syscall.SIGUSR2 }
