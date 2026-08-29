package control

import (
	"encoding/json"
	"testing"
)

func TestListNodesPagedAndFiltered(t *testing.T) {
	_, srv, _ := newTestConsole(t)
	for _, name := range []string{"alpha", "beta", "gamma"} {
		res := doJSON(t, srv, "POST", "/v1/nodes", map[string]string{"name": name, "os": "linux", "arch": "amd64"}, nil)
		if res.StatusCode != 200 {
			t.Fatalf("create %s %d %s", name, res.StatusCode, readBody(t, res))
		}
		readBody(t, res)
	}

	res := doJSON(t, srv, "GET", "/v1/nodes?page=1&size=2", nil, nil)
	if res.StatusCode != 200 {
		t.Fatalf("page %d %s", res.StatusCode, readBody(t, res))
	}
	var page struct {
		Items []map[string]any `json:"items"`
		Total int              `json:"total"`
		Page  int              `json:"page"`
		Size  int              `json:"size"`
	}
	if err := json.NewDecoder(res.Body).Decode(&page); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if page.Total != 3 || page.Size != 2 || len(page.Items) != 2 || page.Page != 1 {
		t.Fatalf("page1 %+v n=%d", page, len(page.Items))
	}

	res = doJSON(t, srv, "GET", "/v1/nodes?q=beta", nil, nil)
	if res.StatusCode != 200 {
		t.Fatalf("filter %d %s", res.StatusCode, readBody(t, res))
	}
	var all []map[string]any
	if err := json.NewDecoder(res.Body).Decode(&all); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if len(all) != 1 || all[0]["name"] != "beta" {
		t.Fatalf("q=beta got %+v", all)
	}

	res = doJSON(t, srv, "GET", "/v1/nodes?status=offline&page=1&size=20", nil, nil)
	if err := json.NewDecoder(res.Body).Decode(&page); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if page.Total != 3 {
		t.Fatalf("status=offline total %d", page.Total)
	}
}

func TestOverviewAlertsGroupOfflineNodes(t *testing.T) {
	_, srv, _ := newTestConsole(t)
	for _, name := range []string{"alpha", "beta", "gamma"} {
		res := doJSON(t, srv, "POST", "/v1/nodes", map[string]string{"name": name, "os": "linux", "arch": "amd64"}, nil)
		if res.StatusCode != 200 {
			t.Fatalf("create %s %d %s", name, res.StatusCode, readBody(t, res))
		}
		readBody(t, res)
	}
	res := doJSON(t, srv, "GET", "/v1/overview", nil, nil)
	if res.StatusCode != 200 {
		t.Fatalf("overview %d %s", res.StatusCode, readBody(t, res))
	}
	var ov struct {
		Alerts         []map[string]any `json:"alerts"`
		NodesOnline    int              `json:"nodesOnline"`
		MappingsActive int              `json:"mappingsActive"`
		RecentAudit    []map[string]any `json:"recentAudit"`
	}
	if err := json.NewDecoder(res.Body).Decode(&ov); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if ov.NodesOnline != 0 || ov.MappingsActive != 0 {
		t.Fatalf("online/active %+v", ov)
	}
	if len(ov.Alerts) != 1 || ov.Alerts[0]["kind"] != "node_offline" {
		t.Fatalf("alerts %+v", ov.Alerts)
	}
	title, _ := ov.Alerts[0]["title"].(string)
	if title != "3 台节点离线，映射无法开流" {
		t.Fatalf("title %q", title)
	}
	if len(ov.RecentAudit) == 0 || ov.RecentAudit[0]["targetName"] == nil || ov.RecentAudit[0]["targetName"] == "" {
		t.Fatalf("recentAudit %+v", ov.RecentAudit)
	}
}

func TestSlicePageClamps(t *testing.T) {
	all := []int{1, 2, 3, 4, 5}
	got := slicePage(all, 9, 2)
	if len(got) != 1 || got[0] != 5 {
		t.Fatalf("got %v", got)
	}
}

func TestListMappingsPagedAndFiltered(t *testing.T) {
	_, srv, _ := newTestConsole(t)
	res := doJSON(t, srv, "POST", "/v1/nodes", map[string]string{"name": "lab", "os": "linux", "arch": "amd64"}, nil)
	var node struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(res.Body).Decode(&node); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	for i, name := range []string{"alpha-map", "beta-map", "gamma-map"} {
		port := 41301 + i
		res = doJSON(t, srv, "POST", "/v1/mappings", map[string]any{
			"nodeId": node.ID, "name": name, "proto": "tcp", "mode": "public",
			"entryPort": port, "localHost": "127.0.0.1", "localPort": 22,
		}, nil)
		if res.StatusCode != 200 {
			t.Fatalf("create %s %d %s", name, res.StatusCode, readBody(t, res))
		}
		readBody(t, res)
	}

	res = doJSON(t, srv, "GET", "/v1/mappings?page=1&size=2", nil, nil)
	if res.StatusCode != 200 {
		t.Fatalf("page %d %s", res.StatusCode, readBody(t, res))
	}
	var page struct {
		Items []map[string]any `json:"items"`
		Total int              `json:"total"`
		Page  int              `json:"page"`
		Size  int              `json:"size"`
	}
	if err := json.NewDecoder(res.Body).Decode(&page); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if page.Total != 3 || page.Size != 2 || len(page.Items) != 2 || page.Page != 1 {
		t.Fatalf("page1 %+v n=%d", page, len(page.Items))
	}

	res = doJSON(t, srv, "GET", "/v1/mappings?q=beta-map&page=1&size=20", nil, nil)
	if err := json.NewDecoder(res.Body).Decode(&page); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if page.Total != 1 || len(page.Items) != 1 || page.Items[0]["name"] != "beta-map" {
		t.Fatalf("q=beta-map %+v", page)
	}

	res = doJSON(t, srv, "GET", "/v1/mappings?proto=tcp&page=2&size=2", nil, nil)
	if err := json.NewDecoder(res.Body).Decode(&page); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if page.Total != 3 || page.Page != 2 || len(page.Items) != 1 {
		t.Fatalf("page2 %+v n=%d", page, len(page.Items))
	}
}

func TestListAuditPagedAndFiltered(t *testing.T) {
	_, srv, _ := newTestConsole(t)
	for _, name := range []string{"alpha", "beta", "gamma"} {
		res := doJSON(t, srv, "POST", "/v1/nodes", map[string]string{"name": name, "os": "linux", "arch": "amd64"}, nil)
		if res.StatusCode != 200 {
			t.Fatalf("create %s %d %s", name, res.StatusCode, readBody(t, res))
		}
		readBody(t, res)
	}

	res := doJSON(t, srv, "GET", "/v1/audit?page=1&size=2", nil, nil)
	if res.StatusCode != 200 {
		t.Fatalf("page %d %s", res.StatusCode, readBody(t, res))
	}
	var page struct {
		Items []map[string]any `json:"items"`
		Total int              `json:"total"`
		Page  int              `json:"page"`
		Size  int              `json:"size"`
	}
	if err := json.NewDecoder(res.Body).Decode(&page); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if page.Total < 3 || page.Size != 2 || len(page.Items) != 2 {
		t.Fatalf("audit page1 %+v n=%d", page, len(page.Items))
	}

	res = doJSON(t, srv, "GET", "/v1/audit?q=beta&page=1&size=20", nil, nil)
	if err := json.NewDecoder(res.Body).Decode(&page); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if page.Total < 1 {
		t.Fatalf("q=beta %+v", page)
	}
	found := false
	for _, it := range page.Items {
		if it["targetName"] == "beta" || it["detail"] == "beta" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected beta in %+v", page.Items)
	}

	res = doJSON(t, srv, "GET", "/v1/audit?action=node.create&page=1&size=20", nil, nil)
	if err := json.NewDecoder(res.Body).Decode(&page); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if page.Total < 3 {
		t.Fatalf("action=node.create total %d", page.Total)
	}
}
