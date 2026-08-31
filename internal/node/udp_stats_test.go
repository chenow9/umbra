package node

import (
	"testing"
	"time"
)

func TestUDPStatsSnapshotAndDelta(t *testing.T) {
	stats := &udpStats{}
	stats.uplaneRxPackets.Store(10)
	stats.targetWritePackets.Store(8)
	stats.activeUDPFlows.Store(3)
	before := stats.snapshot()
	stats.uplaneRxPackets.Add(5)
	stats.targetWritePackets.Add(4)
	stats.activeUDPFlows.Add(-1)
	stats.expiredUDPFlows.Add(1)
	after := stats.snapshot()
	delta := after.sub(before)
	if delta.UPlaneRxPackets != 5 || delta.TargetWritePackets != 4 || delta.ActiveUDPFlows != -1 || delta.ExpiredUDPFlows != 1 {
		t.Fatalf("unexpected delta: %+v", delta)
	}
}

func TestUDPStatsInterval(t *testing.T) {
	t.Setenv("UMBRA_UDP_STATS_INTERVAL", "7")
	if got := udpStatsInterval(); got != 7*time.Second {
		t.Fatalf("interval=%s", got)
	}
	t.Setenv("UMBRA_UDP_STATS_INTERVAL", "0")
	if got := udpStatsInterval(); got != 0 {
		t.Fatalf("zero interval=%s", got)
	}
	t.Setenv("UMBRA_UDP_STATS_INTERVAL", "invalid")
	if got := udpStatsInterval(); got != 0 {
		t.Fatalf("invalid interval=%s", got)
	}
}
