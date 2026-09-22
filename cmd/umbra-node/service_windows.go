//go:build windows

package main

import (
	"context"
	"flag"

	"golang.org/x/sys/windows/svc"
)

// windowsServiceName matches the SCM service. Install commands pass
// --service-name per node; the default keeps an existing UmbraNode service working.
var windowsServiceName = "UmbraNode"

func init() {
	flag.StringVar(&windowsServiceName, "service-name", "UmbraNode", "Windows 服务名（与 SCM 中的名称一致）")
}

type nodeService struct {
	run func(context.Context) error
}

func (s nodeService) Execute(
	_ []string,
	requests <-chan svc.ChangeRequest,
	status chan<- svc.Status,
) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- s.run(ctx) }()
	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}

	for {
		select {
		case err := <-done:
			if err != nil {
				return true, 1
			}
			return false, 0
		case request := <-requests:
			switch request.Cmd {
			case svc.Interrogate:
				status <- request.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending}
				cancel()
				if err := <-done; err != nil {
					return true, 1
				}
				return false, 0
			}
		}
	}
}

func runPlatformService(run func(context.Context) error) (bool, error) {
	isService, err := svc.IsWindowsService()
	if err != nil || !isService {
		return false, err
	}
	name := windowsServiceName
	if name == "" {
		name = "UmbraNode"
	}
	return true, svc.Run(name, nodeService{run: run})
}
