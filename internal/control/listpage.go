package control

import (
	"net/http"
	"strconv"
	"strings"
)

const (
	defaultPageSize = 10
	maxPageSize     = 100
)

func parsePage(r *http.Request) (page, size int, paged bool) {
	q := r.URL.Query()
	if q.Get("page") == "" && q.Get("size") == "" {
		return 1, 0, false
	}
	page = atoiDefault(q.Get("page"), 1)
	size = atoiDefault(q.Get("size"), defaultPageSize)
	if page < 1 {
		page = 1
	}
	if size <= 0 {
		size = defaultPageSize
	}
	if size > maxPageSize {
		size = maxPageSize
	}
	return page, size, true
}

func atoiDefault(s string, d int) int {
	if s == "" {
		return d
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return d
	}
	return n
}

func slicePage[T any](all []T, page, size int) []T {
	if size <= 0 {
		return all
	}
	n := len(all)
	pages := (n + size - 1) / size
	if pages < 1 {
		pages = 1
	}
	if page > pages {
		page = pages
	}
	if page < 1 {
		page = 1
	}
	start := (page - 1) * size
	if start >= n {
		return []T{}
	}
	end := start + size
	if end > n {
		end = n
	}
	return all[start:end]
}

func writeList[T any](w http.ResponseWriter, all []T, page, size int, paged bool) {
	if !paged {
		writeJSON(w, all)
		return
	}
	n := len(all)
	pages := (n + size - 1) / size
	if pages < 1 {
		pages = 1
	}
	if page > pages {
		page = pages
	}
	writeJSON(w, map[string]any{
		"items": slicePage(all, page, size),
		"total": n,
		"page":  page,
		"size":  size,
	})
}

func asString(v any) string {
	if v == nil {
		return ""
	}
	s, _ := v.(string)
	return s
}

func filterNodeViews(views []map[string]any, q, status, os string) []map[string]any {
	q = strings.ToLower(strings.TrimSpace(q))
	status = strings.TrimSpace(status)
	os = strings.TrimSpace(os)
	if q == "" && status == "" && os == "" {
		return views
	}
	out := make([]map[string]any, 0, len(views))
	for _, v := range views {
		if status != "" && asString(v["status"]) != status {
			continue
		}
		if os != "" && asString(v["os"]) != os {
			continue
		}
		if q != "" {
			blob := strings.ToLower(strings.Join([]string{
				asString(v["name"]), asString(v["comment"]), asString(v["addr"]),
				asString(v["os"]), asString(v["arch"]),
			}, " "))
			if !strings.Contains(blob, q) {
				continue
			}
		}
		out = append(out, v)
	}
	return out
}

func filterMappingViews(views []map[string]any, q, nodeID, proto, mode, reach string) []map[string]any {
	q = strings.ToLower(strings.TrimSpace(q))
	nodeID = strings.TrimSpace(nodeID)
	proto = strings.TrimSpace(proto)
	mode = strings.TrimSpace(mode)
	reach = strings.TrimSpace(reach)
	if q == "" && nodeID == "" && proto == "" && mode == "" && reach == "" {
		return views
	}
	out := make([]map[string]any, 0, len(views))
	for _, v := range views {
		if nodeID != "" && asString(v["nodeId"]) != nodeID {
			continue
		}
		if proto != "" && asString(v["proto"]) != proto {
			continue
		}
		if mode != "" && asString(v["mode"]) != mode {
			continue
		}
		if reach != "" && asString(v["reach"]) != reach {
			continue
		}
		if q != "" {
			blob := strings.ToLower(strings.Join([]string{
				asString(v["name"]), asString(v["nodeName"]), asString(v["proto"]),
				asString(v["mode"]), asString(v["localHost"]), asString(v["reach"]),
			}, " "))
			if !strings.Contains(blob, q) {
				continue
			}
		}
		out = append(out, v)
	}
	return out
}

var auditActionLabels = map[string]string{
	"node.create":      "登记节点",
	"node.update":      "修改节点",
	"node.delete":      "删除节点",
	"node.enroll":      "节点登记",
	"node.offline":     "节点离线",
	"node.rotate":      "轮换凭证",
	"node.hello":       "Hello 全量下发",
	"mapping.ack":      "映射确认",
	"mapping.ack_fail": "映射确认失败",
	"acl.drop":         "ACL 丢弃",
	"mapping.push":     "MappingSync",
	"mapping.probe":    "探测开流",
	"mapping.knock":    "SPA 敲门",
	"mapping.visit":    "访客探访",
	"visitor.issue":    "签发访客",
	"visitor.revoke":   "作废访客票据",
	"node.disconnect":  "节点离线",
	"node.revoke":      "吊销凭证",
	"mapping.create":   "新建映射",
	"mapping.update":   "修改映射",
	"mapping.policy":   "更新策略",
	"mapping.delete":   "删除映射",
	"mapping.enable":   "启用映射",
	"mapping.disable":  "停用映射",
	"demo.run":         "跑通演示",
}

func filterAuditViews(views []map[string]any, q, action string) []map[string]any {
	q = strings.ToLower(strings.TrimSpace(q))
	action = strings.TrimSpace(action)
	if q == "" && action == "" {
		return views
	}
	out := make([]map[string]any, 0, len(views))
	for _, v := range views {
		act := asString(v["action"])
		if action != "" && act != action {
			continue
		}
		if q != "" {
			blob := strings.ToLower(strings.Join([]string{
				act, auditActionLabels[act], asString(v["target"]), asString(v["targetName"]),
				asString(v["detail"]), asString(v["actor"]),
			}, " "))
			if !strings.Contains(blob, q) {
				continue
			}
		}
		out = append(out, v)
	}
	return out
}
