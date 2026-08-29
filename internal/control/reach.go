package control

import (
	"fmt"
	"time"

	"umbra/internal/gate"
)

func mappingReach(enabled bool, mode, listen, push, nodeStatus, listenErr string, granted bool, active, maxConns int) string {
	if !enabled {
		return "disabled"
	}
	if listenErr != "" || push == "error" || listen == "error" {
		return "error"
	}
	if nodeStatus != "online" || push == "pending_offline" {
		return "offline"
	}
	if mode == "visitor" {
		if push == "acked" || push == "pending" {
			return "visitor"
		}
		return "pending"
	}
	if push != "acked" {
		return "pending"
	}
	if mode == "spa" && !granted {
		return "closed"
	}
	if maxConns > 0 && active >= maxConns {
		return "full"
	}
	if listen == "listening" || listen == "ready" {
		return "open"
	}
	return "pending"
}

func alertRow(level, kind, title, id, href string) map[string]any {
	row := map[string]any{"level": level, "kind": kind, "title": title, "href": href}
	if id != "" {
		row["id"] = id
	}
	return row
}

func (c *Console) alertsLocked(live map[string]gateNode, stats map[string]gate.MapStat) []map[string]any {
	out := make([]map[string]any, 0, 4)
	offline := 0
	var offlineName, offlineID string
	for _, a := range c.sortedNodes() {
		if a.Status == "revoked" {
			continue
		}
		st, _, _, _, _ := nodeRuntime(a, live)
		if st == "online" {
			continue
		}
		offline++
		if offlineName == "" {
			offlineName, offlineID = a.Name, a.ID
		}
	}
	if offline == 1 {
		out = append(out, alertRow("warn", "node_offline", offlineName+" 离线，映射无法开流", offlineID, "/nodes"))
	} else if offline > 1 {
		out = append(out, alertRow("warn", "node_offline", fmt.Sprintf("%d 台节点离线，映射无法开流", offline), "", "/nodes"))
	}

	now := time.Now()
	errN, dropN := 0, 0
	var errTitle, errID, dropTitle, dropID string
	for _, m := range c.sortedMaps() {
		if !m.Spec.Enabled {
			continue
		}
		st := stats[m.Spec.ID]
		if st.Error != "" {
			errN++
			if errTitle == "" {
				errTitle = m.Spec.Name + " 无法开流：" + st.Error
				errID = m.Spec.ID
			}
		}
		drops := st.TCPDropMaxConns + st.TCPDropACL + st.TCPDropSPA + st.TCPDropOffline + st.TCPDropTunnel + st.TCPDropSplice + st.UDPDropMaxConns + st.UDPDropPerIP + st.UDPDropRate
		if drops > 0 && !st.LastDropAt.IsZero() && now.Sub(st.LastDropAt) < 15*time.Minute {
			dropN++
			if dropTitle == "" {
				dropTitle = m.Spec.Name + " 刚刚丢弃连接（" + dropReasonLabel(st.LastDrop) + "）"
				dropID = m.Spec.ID
			}
		}
	}
	if errN == 1 {
		out = append(out, alertRow("error", "mapping_error", errTitle, errID, "/mappings"))
	} else if errN > 1 {
		out = append(out, alertRow("error", "mapping_error", fmt.Sprintf("%d 条映射无法开流", errN), "", "/mappings"))
	}
	if dropN == 1 {
		out = append(out, alertRow("warn", "mapping_drop", dropTitle, dropID, "/mappings"))
	} else if dropN > 1 {
		out = append(out, alertRow("warn", "mapping_drop", fmt.Sprintf("%d 条映射刚刚丢弃连接", dropN), "", "/mappings"))
	}
	return out
}

func dropReasonLabel(reason string) string {
	switch reason {
	case "maxconns":
		return "连接已满"
	case "acl":
		return "网段不允许"
	case "spa":
		return "未敲门"
	case "offline":
		return "节点不在线"
	case "splice":
		return "入口配额已满"
	case "tunnel":
		return "隧道开流失败"
	default:
		if reason == "" {
			return "丢弃"
		}
		return reason
	}
}
