package node

import (
	"context"
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type udpStats struct {
	uplaneRxPackets     atomic.Int64
	uplaneRxBytes       atomic.Int64
	uplaneReadErrors    atomic.Int64
	uplaneDecodeErrors  atomic.Int64
	unknownMappingDrops atomic.Int64
	emptyFlowIDDrops    atomic.Int64
	targetResolveErrors atomic.Int64
	targetDialErrors    atomic.Int64
	targetWritePackets  atomic.Int64
	targetWriteBytes    atomic.Int64
	targetWriteErrors   atomic.Int64
	targetRxPackets     atomic.Int64
	targetRxBytes       atomic.Int64
	targetReadErrors    atomic.Int64
	uplaneTxPackets     atomic.Int64
	uplaneTxBytes       atomic.Int64
	uplaneEncodeErrors  atomic.Int64
	uplaneWriteErrors   atomic.Int64
	activeUDPFlows      atomic.Int64
	expiredUDPFlows     atomic.Int64
}

type udpStatsSnapshot struct {
	UPlaneRxPackets     int64 `json:"uplaneRxPackets"`
	UPlaneRxBytes       int64 `json:"uplaneRxBytes"`
	UPlaneReadErrors    int64 `json:"uplaneReadErrors"`
	UPlaneDecodeErrors  int64 `json:"uplaneDecodeErrors"`
	UnknownMappingDrops int64 `json:"unknownMappingDrops"`
	EmptyFlowIDDrops    int64 `json:"emptyFlowIdDrops"`
	TargetResolveErrors int64 `json:"targetResolveErrors"`
	TargetDialErrors    int64 `json:"targetDialErrors"`
	TargetWritePackets  int64 `json:"targetWritePackets"`
	TargetWriteBytes    int64 `json:"targetWriteBytes"`
	TargetWriteErrors   int64 `json:"targetWriteErrors"`
	TargetRxPackets     int64 `json:"targetRxPackets"`
	TargetRxBytes       int64 `json:"targetRxBytes"`
	TargetReadErrors    int64 `json:"targetReadErrors"`
	UPlaneTxPackets     int64 `json:"uplaneTxPackets"`
	UPlaneTxBytes       int64 `json:"uplaneTxBytes"`
	UPlaneEncodeErrors  int64 `json:"uplaneEncodeErrors"`
	UPlaneWriteErrors   int64 `json:"uplaneWriteErrors"`
	ActiveUDPFlows      int64 `json:"activeUdpFlows"`
	ExpiredUDPFlows     int64 `json:"expiredUdpFlows"`
}

func (s *udpStats) snapshot() udpStatsSnapshot {
	if s == nil {
		return udpStatsSnapshot{}
	}
	return udpStatsSnapshot{
		UPlaneRxPackets: s.uplaneRxPackets.Load(), UPlaneRxBytes: s.uplaneRxBytes.Load(),
		UPlaneReadErrors: s.uplaneReadErrors.Load(), UPlaneDecodeErrors: s.uplaneDecodeErrors.Load(),
		UnknownMappingDrops: s.unknownMappingDrops.Load(), EmptyFlowIDDrops: s.emptyFlowIDDrops.Load(),
		TargetResolveErrors: s.targetResolveErrors.Load(), TargetDialErrors: s.targetDialErrors.Load(),
		TargetWritePackets: s.targetWritePackets.Load(), TargetWriteBytes: s.targetWriteBytes.Load(),
		TargetWriteErrors: s.targetWriteErrors.Load(), TargetRxPackets: s.targetRxPackets.Load(),
		TargetRxBytes: s.targetRxBytes.Load(), TargetReadErrors: s.targetReadErrors.Load(),
		UPlaneTxPackets: s.uplaneTxPackets.Load(), UPlaneTxBytes: s.uplaneTxBytes.Load(),
		UPlaneEncodeErrors: s.uplaneEncodeErrors.Load(), UPlaneWriteErrors: s.uplaneWriteErrors.Load(),
		ActiveUDPFlows: s.activeUDPFlows.Load(), ExpiredUDPFlows: s.expiredUDPFlows.Load(),
	}
}

func (a udpStatsSnapshot) sub(b udpStatsSnapshot) udpStatsSnapshot {
	a.UPlaneRxPackets -= b.UPlaneRxPackets
	a.UPlaneRxBytes -= b.UPlaneRxBytes
	a.UPlaneReadErrors -= b.UPlaneReadErrors
	a.UPlaneDecodeErrors -= b.UPlaneDecodeErrors
	a.UnknownMappingDrops -= b.UnknownMappingDrops
	a.EmptyFlowIDDrops -= b.EmptyFlowIDDrops
	a.TargetResolveErrors -= b.TargetResolveErrors
	a.TargetDialErrors -= b.TargetDialErrors
	a.TargetWritePackets -= b.TargetWritePackets
	a.TargetWriteBytes -= b.TargetWriteBytes
	a.TargetWriteErrors -= b.TargetWriteErrors
	a.TargetRxPackets -= b.TargetRxPackets
	a.TargetRxBytes -= b.TargetRxBytes
	a.TargetReadErrors -= b.TargetReadErrors
	a.UPlaneTxPackets -= b.UPlaneTxPackets
	a.UPlaneTxBytes -= b.UPlaneTxBytes
	a.UPlaneEncodeErrors -= b.UPlaneEncodeErrors
	a.UPlaneWriteErrors -= b.UPlaneWriteErrors
	a.ActiveUDPFlows -= b.ActiveUDPFlows
	a.ExpiredUDPFlows -= b.ExpiredUDPFlows
	return a
}

func udpStatsInterval() time.Duration {
	v := strings.TrimSpace(os.Getenv("UMBRA_UDP_STATS_INTERVAL"))
	if v == "" {
		return 0
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return 0
	}
	return time.Duration(n) * time.Second
}

func (s *udpStats) startReporter(ctx context.Context, nodeID string, interval time.Duration) func() {
	if interval <= 0 {
		return func() {}
	}
	stop := make(chan struct{})
	done := make(chan struct{})
	var once sync.Once
	go func() {
		defer close(done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		previous := s.snapshot()
		for {
			select {
			case <-ctx.Done():
				return
			case <-stop:
				return
			case <-ticker.C:
				current := s.snapshot()
				writeUDPStats(nodeID, interval, false, current, current.sub(previous))
				previous = current
			}
		}
	}()
	return func() {
		once.Do(func() {
			close(stop)
			<-done
			current := s.snapshot()
			writeUDPStats(nodeID, interval, true, current, udpStatsSnapshot{})
		})
	}
}

func writeUDPStats(nodeID string, interval time.Duration, final bool, cumulative, delta udpStatsSnapshot) {
	record := struct {
		Event       string           `json:"event"`
		Timestamp   string           `json:"timestamp"`
		NodeID      string           `json:"nodeId,omitempty"`
		IntervalSec int64            `json:"intervalSec"`
		Final       bool             `json:"final"`
		Cumulative  udpStatsSnapshot `json:"cumulative"`
		Delta       udpStatsSnapshot `json:"delta,omitempty"`
	}{
		Event: "udp_stats", Timestamp: time.Now().UTC().Format(time.RFC3339Nano), NodeID: nodeID,
		IntervalSec: int64(interval / time.Second), Final: final, Cumulative: cumulative, Delta: delta,
	}
	raw, err := json.Marshal(record)
	if err != nil {
		return
	}
	raw = append(raw, '\n')
	_, _ = os.Stderr.Write(raw)
}
