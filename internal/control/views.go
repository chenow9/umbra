package control

import (
	"sort"
	"time"

	"umbra/internal/gate"
)

func rfc3339(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

func rfc3339Ptr(t *time.Time) string {
	if t == nil {
		return ""
	}
	return rfc3339(*t)
}

func (c *Console) sortedNodes() []*nodeRec {
	out := make([]*nodeRec, 0, len(c.nodes))
	for _, n := range c.nodes {
		out = append(out, n)
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].Created.Equal(out[j].Created) {
			return out[i].Created.After(out[j].Created)
		}
		return out[i].ID > out[j].ID
	})
	return out
}

func (c *Console) sortedMaps() []*mapRec {
	out := make([]*mapRec, 0, len(c.maps))
	for _, m := range c.maps {
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].Created.Equal(out[j].Created) {
			return out[i].Created.After(out[j].Created)
		}
		return out[i].Spec.ID > out[j].Spec.ID
	})
	return out
}

func nodeRuntime(a *nodeRec, live map[string]gateNode) (st, addr, ver, os, arch string) {
	st, addr, ver, os, arch = a.Status, a.Addr, a.Version, a.OS, a.Arch
	if g, ok := live[a.ID]; ok && g.Online && a.Status != "revoked" {
		st = "online"
		addr, ver = g.Addr, g.Ver
		if g.OS != "" {
			os = g.OS
		}
		if g.Arch != "" {
			arch = g.Arch
		}
	} else if a.Status != "revoked" {
		st = "offline"
	}
	return
}

func (c *Console) absorbAllLocked(stats map[string]gate.MapStat) {
	for id, rec := range c.maps {
		if s, ok := stats[id]; ok {
			rec.absorbStats(s.In, s.Out)
		}
	}
}

func (c *Console) touchOnlineLocked(live map[string]gateNode, now time.Time) {
	for id, a := range c.nodes {
		g, ok := live[id]
		if !ok || !g.Online || a.Status == "revoked" {
			continue
		}
		ts := now
		a.LastSeen = &ts
		if g.Addr != "" {
			a.Addr = g.Addr
		}
		if g.Ver != "" {
			a.Version = g.Ver
		}
		if g.OS != "" {
			a.OS = g.OS
		}
		if g.Arch != "" {
			a.Arch = g.Arch
		}
	}
}

func (c *Console) nodeView(a *nodeRec, live map[string]gateNode, stats map[string]gate.MapStat) map[string]any {
	st, addr, ver, os, arch := nodeRuntime(a, live)
	n, in, outB := 0, int64(0), int64(0)
	var bpsIn, bpsOut float64
	for _, m := range c.maps {
		if m.NodeID != a.ID {
			continue
		}
		n++
		in += m.BytesIn
		outB += m.BytesOut
		b := c.bpsBy[m.Spec.ID]
		bpsIn += b[0]
		bpsOut += b[1]
	}
	last := rfc3339Ptr(a.LastSeen)
	if st == "online" && last == "" {
		last = rfc3339(time.Now())
	}
	return map[string]any{
		"id": a.ID, "name": a.Name, "comment": a.Comment, "status": st,
		"addr": addr, "version": ver, "os": os, "arch": arch,
		"lastSeen": last, "enabled": a.Enabled && a.Status != "revoked",
		"createdAt":      rfc3339(a.Created),
		"tokenExpiresAt": rfc3339(a.TokenUntil),
		"mappingCount":   n, "bytesIn": in, "bytesOut": outB,
		"bpsIn": int64(bpsIn), "bpsOut": int64(bpsOut),
	}
}

func (c *Console) mappingView(m *mapRec, live map[string]gateNode, stats map[string]gate.MapStat) map[string]any {
	a := c.nodes[m.NodeID]
	name, ast := "", "offline"
	if a != nil {
		st, _, _, _, _ := nodeRuntime(a, live)
		name, ast = a.Name, st
	}
	in, outB, active := m.BytesIn, m.BytesOut, 0
	udpActive, dropMax, dropIP, dropRate := 0, int64(0), int64(0), int64(0)
	var tcpMax, tcpACL, tcpSPA, tcpOff, tcpTun, tcpSplice int64
	lastDrop, lastDropAt := "", ""
	listen, push, listenErr := m.ListenState, m.PushState, m.ListenError
	udpVia := ""
	granted := false
	grantUntil := ""
	if until := c.Gate.GrantUntil(m.Spec.ID); !until.IsZero() {
		granted = true
		grantUntil = rfc3339(until)
	}
	if !m.Spec.Enabled {
		listen, push, listenErr = "disabled", "acked", ""
	} else if s, ok := stats[m.Spec.ID]; ok {
		active = s.Active
		udpActive, dropMax, dropIP, dropRate = s.UDPActive, s.UDPDropMaxConns, s.UDPDropPerIP, s.UDPDropRate
		tcpMax, tcpACL, tcpSPA = s.TCPDropMaxConns, s.TCPDropACL, s.TCPDropSPA
		tcpOff, tcpTun, tcpSplice = s.TCPDropOffline, s.TCPDropTunnel, s.TCPDropSplice
		lastDrop = s.LastDrop
		if !s.LastDropAt.IsZero() {
			lastDropAt = rfc3339(s.LastDropAt)
		}
		udpVia = s.UDPVia
		if s.Error != "" {
			listen, listenErr = "error", s.Error
		} else if m.Spec.Mode == "visitor" {
			listen, listenErr = "ready", ""
		} else if s.Listening {
			listen, listenErr = "listening", ""
		} else {
			listen, listenErr = "pending", ""
		}
		if ast != "online" {
			push = "pending_offline"
		} else if s.Error != "" {
			push = "error"
		} else if s.Acked {
			push = "acked"
		} else {
			push = "pending"
		}
	} else if ast == "online" && m.Spec.Mode == "visitor" {
		listen, push = "ready", "pending"
	} else if ast != "online" {
		push = "pending_offline"
		if listen == "" {
			listen = "pending"
		}
	}
	port := any(nil)
	if m.Spec.EntryPort != nil {
		port = *m.Spec.EntryPort
	}
	bps := c.bpsBy[m.Spec.ID]
	reach := mappingReach(m.Spec.Enabled, m.Spec.Mode, listen, push, ast, listenErr, granted, active, m.Spec.MaxConns)
	return map[string]any{
		"id": m.Spec.ID, "nodeId": m.NodeID, "nodeName": name, "nodeStatus": ast,
		"name": m.Spec.Name, "proto": m.Spec.Proto, "mode": m.Spec.Mode,
		"entryPort": port, "localHost": m.Spec.LocalHost, "localPort": m.Spec.LocalPort,
		"enabled": m.Spec.Enabled, "listenState": listen, "listenError": nilIfEmpty(listenErr),
		"pushState": push, "bytesIn": in, "bytesOut": outB, "activeConns": active,
		"udpActive": udpActive, "udpDropMaxConns": dropMax, "udpDropPerIP": dropIP, "udpDropRate": dropRate,
		"tcpDropMaxConns": tcpMax, "tcpDropAcl": tcpACL, "tcpDropSpa": tcpSPA,
		"tcpDropOffline": tcpOff, "tcpDropTunnel": tcpTun, "tcpDropSplice": tcpSplice,
		"lastDrop": lastDrop, "lastDropAt": lastDropAt,
		"lastProbeAt": rfc3339Ptr(m.LastProbe), "lastProbePreview": m.LastPreview, "grantUntil": grantUntil,
		"maxConns": m.Spec.MaxConns, "rateKbps": m.Spec.RateKbps, "allowCidrs": m.Spec.AllowCidrs,
		"idleTimeoutSec": m.Spec.IdleTimeoutSec,
		"reach":          reach, "udpVia": udpVia, "bpsIn": int64(bps[0]), "bpsOut": int64(bps[1]),
		"createdAt": rfc3339(m.Created),
		"updatedAt": rfc3339(m.Updated),
	}
}

func (c *Console) nodeViews(live map[string]gateNode, stats map[string]gate.MapStat) []map[string]any {
	list := c.sortedNodes()
	out := make([]map[string]any, 0, len(list))
	for _, a := range list {
		out = append(out, c.nodeView(a, live, stats))
	}
	return out
}

func (c *Console) mappingViews(live map[string]gateNode, stats map[string]gate.MapStat) []map[string]any {
	list := c.sortedMaps()
	out := make([]map[string]any, 0, len(list))
	for _, m := range list {
		out = append(out, c.mappingView(m, live, stats))
	}
	return out
}

func (c *Console) overviewView(live map[string]gateNode, stats map[string]gate.MapStat) map[string]any {
	online, total := 0, len(c.nodes)
	for _, a := range c.nodes {
		if g, ok := live[a.ID]; ok && g.Online && a.Status != "revoked" {
			online++
		}
	}
	maps := len(c.maps)
	active := 0
	for _, m := range c.maps {
		if !m.Spec.Enabled {
			continue
		}
		ast := "offline"
		if a := c.nodes[m.NodeID]; a != nil {
			st, _, _, _, _ := nodeRuntime(a, live)
			ast = st
		}
		if ast == "online" {
			active++
		}
	}
	var liveIn, liveOut int64
	for _, m := range c.maps {
		liveIn += m.BytesIn
		liveOut += m.BytesOut
	}
	now := time.Now()
	midnight := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	var baseIn, baseOut int64
	for _, s := range c.samples {
		if s.Ts.Before(midnight) {
			baseIn, baseOut = s.In, s.Out
		}
	}
	dayIn, dayOut := liveIn-baseIn, liveOut-baseOut
	if dayIn < 0 {
		dayIn = liveIn
	}
	if dayOut < 0 {
		dayOut = liveOut
	}
	bpsIn, bpsOut := c.bpsIn, c.bpsOut
	if c.rateTs.IsZero() {
		if n := len(c.samples); n >= 2 {
			a, b := c.samples[n-2], c.samples[n-1]
			dt := b.Ts.Sub(a.Ts).Seconds()
			if dt > 0 {
				if d := b.In - a.In; d > 0 {
					bpsIn = float64(d) / dt
				}
				if d := b.Out - a.Out; d > 0 {
					bpsOut = float64(d) / dt
				}
			}
		}
	}
	recent := []map[string]any{}
	for i := len(c.audit) - 1; i >= 0 && len(recent) < 8; i-- {
		a := c.audit[i]
		recent = append(recent, map[string]any{
			"id": a.ID, "ts": a.Ts.UTC().Format(time.RFC3339),
			"actor": a.Actor, "action": a.Action, "target": a.Target, "detail": a.Detail,
			"targetName": c.targetNameLocked(a.Target),
		})
	}
	return map[string]any{
		"nodesOnline": online, "nodesTotal": total,
		"mappingsActive": active, "mappingsTotal": maps,
		"bytesInToday": dayIn, "bytesOutToday": dayOut,
		"bpsIn": int64(bpsIn), "bpsOut": int64(bpsOut),
		"recentAudit": recent,
		"alerts":      c.alertsLocked(live, stats),
	}
}

func (c *Console) latestSample() map[string]any {
	if len(c.samples) == 0 {
		return nil
	}
	s := c.samples[len(c.samples)-1]
	by := map[string]map[string]int64{}
	for id, pair := range s.By {
		by[id] = map[string]int64{"bytesIn": pair[0], "bytesOut": pair[1]}
	}
	return map[string]any{
		"ts": s.Ts.UTC().Format(time.RFC3339), "bytesIn": s.In, "bytesOut": s.Out, "by": by,
	}
}

func (c *Console) refreshRatesLocked(stats map[string]gate.MapStat, now time.Time) {
	var in, out int64
	for _, s := range stats {
		in += s.In
		out += s.Out
	}
	dt := now.Sub(c.rateTs).Seconds()
	if c.rateTs.IsZero() || dt < 0.45 {
		if c.rateTs.IsZero() {
			c.rateIn, c.rateOut, c.rateTs = in, out, now
			if c.rateBy == nil {
				c.rateBy = map[string][2]int64{}
			}
			for id, s := range stats {
				c.rateBy[id] = [2]int64{s.In, s.Out}
			}
		}
		return
	}
	if d := in - c.rateIn; d > 0 {
		c.bpsIn = float64(d) / dt
	} else {
		c.bpsIn = 0
	}
	if d := out - c.rateOut; d > 0 {
		c.bpsOut = float64(d) / dt
	} else {
		c.bpsOut = 0
	}
	c.rateIn, c.rateOut, c.rateTs = in, out, now
	nextRate := map[string][2]int64{}
	nextBps := map[string][2]float64{}
	for id, s := range stats {
		prev := c.rateBy[id]
		var bi, bo float64
		if d := s.In - prev[0]; d > 0 {
			bi = float64(d) / dt
		}
		if d := s.Out - prev[1]; d > 0 {
			bo = float64(d) / dt
		}
		nextRate[id] = [2]int64{s.In, s.Out}
		nextBps[id] = [2]float64{bi, bo}
	}
	c.rateBy, c.bpsBy = nextRate, nextBps
}

func (c *Console) livePayload() map[string]any {
	live := c.live()
	stats := c.Gate.MappingStats()
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()
	c.touchOnlineLocked(live, now)
	c.absorbAllLocked(stats)
	c.refreshRatesLocked(stats, now)
	return map[string]any{
		"ts":       now.UTC().Format(time.RFC3339),
		"overview": c.overviewView(live, stats),
		"nodes":    c.nodeViews(live, stats),
		"mappings": c.mappingViews(live, stats),
		"sample":   c.latestSample(),
	}
}
