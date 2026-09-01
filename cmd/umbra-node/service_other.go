//go:build !windows

package main

import "context"

func runPlatformService(func(context.Context) error) (bool, error) {
	return false, nil
}
