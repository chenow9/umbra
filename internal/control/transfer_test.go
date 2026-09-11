package control

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"umbra/internal/wire"
)

func testCreateNode(t *testing.T, srv *httptest.Server, name string) (id, token string) {
	t.Helper()
	res := doJSON(t, srv, "POST", "/v1/nodes", map[string]any{
		"name": name, "comment": name + " note", "os": "linux", "arch": "amd64",
	}, nil)
	body := readBody(t, res)
	if res.StatusCode != 200 {
		t.Fatalf("create node %d %s", res.StatusCode, body)
	}
	var out struct {
		ID    string `json:"id"`
		Token string `json:"token"`
	}
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatal(err)
	}
	return out.ID, out.Token
}

func testCreateMapping(t *testing.T, srv *httptest.Server, nodeID, name, proto, mode string, entry, local int) string {
	t.Helper()
	payload := map[string]any{
		"nodeId": nodeID, "name": name, "proto": proto, "mode": mode,
		"localHost": "127.0.0.1", "localPort": local,
		"maxConns": 8, "rateKbps": 512, "allowCidrs": "10.0.0.0/8",
		"idleTimeoutSec": 30, "spaTtlSec": 45, "udpIdleTimeoutSec": 90,
	}
	if mode != "visitor" {
		payload["entryPort"] = entry
	}
	res := doJSON(t, srv, "POST", "/v1/mappings", payload, nil)
	body := readBody(t, res)
	if res.StatusCode != 200 {
		t.Fatalf("create mapping %d %s", res.StatusCode, body)
	}
	var out struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatal(err)
	}
	return out.ID
}

func testExport(t *testing.T, srv *httptest.Server, nodeIDs ...string) ConfigBundle {
	t.Helper()
	nodes := make([]map[string]any, 0, len(nodeIDs))
	for _, id := range nodeIDs {
		nodes = append(nodes, map[string]any{"id": id})
	}
	res := doJSON(t, srv, "POST", "/v1/export", map[string]any{"nodes": nodes}, nil)
	body := readBody(t, res)
	if res.StatusCode != 200 {
		t.Fatalf("export %d %s", res.StatusCode, body)
	}
	var bundle ConfigBundle
	if err := json.Unmarshal([]byte(body), &bundle); err != nil {
		t.Fatal(err)
	}
	return bundle
}

func testImport(t *testing.T, srv *httptest.Server, bundle ConfigBundle, bindings []map[string]any) (*http.Response, string) {
	t.Helper()
	res := doJSON(t, srv, "POST", "/v1/import", map[string]any{"bundle": bundle, "bindings": bindings}, nil)
	return res, readBody(t, res)
}

func persistRaw(t *testing.T, c *Console) string {
	t.Helper()
	raw, err := os.ReadFile(c.Persist)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestExportImportRoundTripFieldsAndSecrets(t *testing.T) {
	src, srcSrv, _ := newTestConsole(t)
	dst, dstSrv, _ := newTestConsole(t)
	nodeID, token := testCreateNode(t, srcSrv, "office")
	mapID := testCreateMapping(t, srcSrv, nodeID, "ssh", "tcp", "public", 22022, 22)
	res := doJSON(t, srcSrv, "POST", "/v1/mappings/"+mapID+"/enabled", map[string]any{"enabled": false}, nil)
	if res.StatusCode != 200 {
		t.Fatal(readBody(t, res))
	}
	readBody(t, res)

	res = doJSON(t, srcSrv, "POST", "/v1/export", map[string]any{
		"nodes": []map[string]any{{"id": nodeID}},
	}, nil)
	raw := readBody(t, res)
	if res.StatusCode != 200 {
		t.Fatal(raw)
	}
	if strings.Contains(raw, token) || strings.Contains(raw, "umbra_boot_") {
		t.Fatal("export leaked credential")
	}
	for _, key := range []string{"token", "tokenHash", "revealed", "listenState", "pushState", "bytesIn", "tickets"} {
		if strings.Contains(raw, `"`+key+`"`) {
			t.Fatalf("export contains %s", key)
		}
	}
	var bundle ConfigBundle
	if err := json.Unmarshal([]byte(raw), &bundle); err != nil {
		t.Fatal(err)
	}
	if bundle.SchemaVersion != 1 || bundle.Kind != configBundleKind || bundle.SourceID == "" {
		t.Fatalf("%+v", bundle)
	}
	if len(bundle.Nodes) != 1 || bundle.Nodes[0].ID != nodeID || bundle.Nodes[0].Name != "office" {
		t.Fatalf("%+v", bundle.Nodes)
	}
	if len(bundle.Services) != 1 || bundle.Services[0].Enabled {
		t.Fatalf("%+v", bundle.Services)
	}
	svc := bundle.Services[0]
	if svc.Name != "ssh" || svc.EntryPort == nil || *svc.EntryPort != 22022 || svc.MaxConns != 8 || svc.RateKbps != 512 {
		t.Fatalf("%+v", svc)
	}
	if svc.AllowCidrs != "10.0.0.0/8" || svc.IdleTimeoutSec != 30 || svc.SpaTTLSec != 45 || svc.UdpIdleTimeoutSec != 90 {
		t.Fatalf("%+v", svc)
	}

	preview := doJSON(t, dstSrv, "POST", "/v1/import/preview", map[string]any{"bundle": bundle}, nil)
	if preview.StatusCode != 200 {
		t.Fatal(readBody(t, preview))
	}
	readBody(t, preview)
	if len(dst.nodes) != 0 || len(dst.maps) != 0 {
		t.Fatal("preview must not write")
	}

	res, out := testImport(t, dstSrv, bundle, []map[string]any{{
		"originNodeId": nodeID, "action": "create", "name": "office-copy",
	}})
	if res.StatusCode != 200 {
		t.Fatal(out)
	}
	var imported importResult
	if err := json.Unmarshal([]byte(out), &imported); err != nil {
		t.Fatal(err)
	}
	if !imported.Saved || len(imported.Nodes) != 1 || imported.Nodes[0].LocalID == nodeID {
		t.Fatalf("must mint a new node id: %s", out)
	}
	if imported.Nodes[0].Token == "" || imported.Nodes[0].Token == token || imported.Nodes[0].InstallCmd == "" {
		t.Fatal("new credential and enroll command missing")
	}
	localMap := imported.Services[0].LocalID
	dst.mu.Lock()
	got := dst.maps[localMap]
	if got == nil || got.Spec.Enabled {
		dst.mu.Unlock()
		t.Fatal("disabled service not preserved")
	}
	if got.Spec.Name != "ssh" || got.Spec.MaxConns != 8 || got.Spec.RateKbps != 512 || got.Spec.AllowCidrs != "10.0.0.0/8" {
		dst.mu.Unlock()
		t.Fatalf("%+v", got.Spec)
	}
	if got.Spec.IdleTimeoutSec != 30 || got.Spec.SpaTTLSec != 45 || got.Spec.UdpIdleTimeoutSec != 90 {
		dst.mu.Unlock()
		t.Fatalf("%+v", got.Spec)
	}
	dst.mu.Unlock()
	if strings.Contains(persistRaw(t, dst), imported.Nodes[0].Token) {
		t.Fatal("plaintext token stored")
	}
	dst.mu.Lock()
	for _, a := range dst.audit {
		if strings.Contains(a.Detail, imported.Nodes[0].Token) {
			dst.mu.Unlock()
			t.Fatal("import audit leaked token")
		}
	}
	dst.mu.Unlock()
	src.mu.Lock()
	for _, a := range src.audit {
		if strings.Contains(a.Detail, token) {
			src.mu.Unlock()
			t.Fatal("export audit leaked token")
		}
	}
	src.mu.Unlock()
}

func TestRepeatImportSkipAndUpdate(t *testing.T) {
	_, srcSrv, _ := newTestConsole(t)
	dst, dstSrv, _ := newTestConsole(t)
	nodeID, _ := testCreateNode(t, srcSrv, "n1")
	testCreateMapping(t, srcSrv, nodeID, "web", "tcp", "visitor", 0, 8080)
	bundle := testExport(t, srcSrv, nodeID)

	res, out := testImport(t, dstSrv, bundle, []map[string]any{{
		"originNodeId": nodeID, "action": "create",
	}})
	if res.StatusCode != 200 {
		t.Fatal(out)
	}
	var first importResult
	if err := json.Unmarshal([]byte(out), &first); err != nil {
		t.Fatal(err)
	}
	localNode := first.Nodes[0].LocalID
	localMap := first.Services[0].LocalID

	res, out = testImport(t, dstSrv, bundle, []map[string]any{{
		"originNodeId": nodeID, "action": "bind", "localNodeId": localNode,
	}})
	if res.StatusCode != 200 {
		t.Fatal(out)
	}
	var skipped importResult
	if err := json.Unmarshal([]byte(out), &skipped); err != nil {
		t.Fatal(err)
	}
	if skipped.Summary.ServicesSkip != 1 || skipped.Summary.ServicesCreate != 0 || skipped.Services[0].LocalID != localMap {
		t.Fatalf("skip: %s", out)
	}
	if len(dst.maps) != 1 {
		t.Fatalf("duplicate create: %d", len(dst.maps))
	}

	bundle.Services[0].LocalPort = 9090
	bundle.Services[0].Name = "web-2"
	res, out = testImport(t, dstSrv, bundle, []map[string]any{{
		"originNodeId": nodeID, "action": "bind", "localNodeId": localNode,
		"services": []map[string]any{{"originId": bundle.Services[0].ID, "action": "update"}},
	}})
	if res.StatusCode != 200 {
		t.Fatal(out)
	}
	var updated importResult
	if err := json.Unmarshal([]byte(out), &updated); err != nil {
		t.Fatal(err)
	}
	if updated.Summary.ServicesUpdate != 1 || updated.Services[0].LocalID != localMap {
		t.Fatalf("update: %s", out)
	}
	dst.mu.Lock()
	got := dst.maps[localMap]
	if got.Spec.LocalPort != 9090 || got.Spec.Name != "web-2" {
		dst.mu.Unlock()
		t.Fatalf("%+v", got.Spec)
	}
	dst.mu.Unlock()
}

func TestImportBindingIsolation(t *testing.T) {
	_, srcSrv, _ := newTestConsole(t)
	dst, dstSrv, _ := newTestConsole(t)
	nodeID, _ := testCreateNode(t, srcSrv, "n1")
	testCreateMapping(t, srcSrv, nodeID, "web", "tcp", "visitor", 0, 8080)
	bundle := testExport(t, srcSrv, nodeID)

	res, out := testImport(t, dstSrv, bundle, []map[string]any{{"originNodeId": nodeID, "action": "create"}})
	if res.StatusCode != 200 {
		t.Fatal(out)
	}
	var a importResult
	_ = json.Unmarshal([]byte(out), &a)
	res, out = testImport(t, dstSrv, bundle, []map[string]any{{"originNodeId": nodeID, "action": "create", "name": "copy-b"}})
	if res.StatusCode != 200 {
		t.Fatal(out)
	}
	var b importResult
	_ = json.Unmarshal([]byte(out), &b)
	if a.Nodes[0].LocalID == b.Nodes[0].LocalID || a.Services[0].LocalID == b.Services[0].LocalID {
		t.Fatal("bindings must not be reused across target nodes")
	}
	bundle.Services[0].LocalPort = 7000
	res, out = testImport(t, dstSrv, bundle, []map[string]any{{
		"originNodeId": nodeID, "action": "bind", "localNodeId": a.Nodes[0].LocalID,
		"services": []map[string]any{{"originId": bundle.Services[0].ID, "action": "update"}},
	}})
	if res.StatusCode != 200 {
		t.Fatal(out)
	}
	dst.mu.Lock()
	defer dst.mu.Unlock()
	if dst.maps[a.Services[0].LocalID].Spec.LocalPort != 7000 {
		t.Fatal("target A should update")
	}
	if dst.maps[b.Services[0].LocalID].Spec.LocalPort != 8080 {
		t.Fatal("target B must stay isolated")
	}
}

func TestImportPortConflictIsGateWide(t *testing.T) {
	_, srcSrv, _ := newTestConsole(t)
	dst, dstSrv, _ := newTestConsole(t)
	srcNode, _ := testCreateNode(t, srcSrv, "src")
	testCreateMapping(t, srcSrv, srcNode, "a", "tcp", "public", 18080, 80)
	bundle := testExport(t, srcSrv, srcNode)

	other, _ := testCreateNode(t, dstSrv, "other")
	testCreateMapping(t, dstSrv, other, "taken", "tcp", "public", 18080, 81)

	res, out := testImport(t, dstSrv, bundle, []map[string]any{{"originNodeId": srcNode, "action": "create"}})
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("status %d %s", res.StatusCode, out)
	}
	if !strings.Contains(out, "18080") {
		t.Fatal(out)
	}
	if len(dst.nodes) != 1 {
		t.Fatal("conflict must not create a node")
	}
}

func TestImportBatchPortConflict(t *testing.T) {
	dst, dstSrv, _ := newTestConsole(t)
	port := 19090
	bundle := ConfigBundle{
		SchemaVersion: 1, Kind: configBundleKind, SourceID: "src_batch1",
		Nodes: []ExportNode{{ID: "nde_one", Name: "n1"}, {ID: "nde_two", Name: "n2"}},
		Services: []ExportService{
			{ID: "map_one", NodeID: "nde_one", Name: "a", Proto: "tcp", Mode: "public", EntryPort: &port, LocalHost: "127.0.0.1", LocalPort: 80, Enabled: true},
			{ID: "map_two", NodeID: "nde_two", Name: "b", Proto: "tcp", Mode: "public", EntryPort: &port, LocalHost: "127.0.0.1", LocalPort: 81, Enabled: true},
		},
	}
	res, out := testImport(t, dstSrv, bundle, []map[string]any{
		{"originNodeId": "nde_one", "action": "create"},
		{"originNodeId": "nde_two", "action": "create", "name": "n2-copy"},
	})
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("status %d %s", res.StatusCode, out)
	}
	if len(dst.nodes) != 0 || len(dst.maps) != 0 {
		t.Fatal("batch conflict left partial state")
	}
}

func TestImportMalformedAndLimits(t *testing.T) {
	_, srv, _ := newTestConsole(t)
	res := doJSON(t, srv, "POST", "/v1/import/preview", map[string]any{
		"bundle": map[string]any{"schemaVersion": 9, "kind": configBundleKind, "sourceId": "src_x", "nodes": []any{}},
	}, nil)
	if res.StatusCode != 400 {
		t.Fatalf("schema %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)

	res = doJSON(t, srv, "POST", "/v1/import/preview", map[string]any{
		"bundle": map[string]any{
			"schemaVersion": 1, "kind": configBundleKind, "sourceId": "src_x",
			"token": "umbra_boot_nope",
			"nodes": []map[string]any{{"id": "nde_a", "name": "n"}},
		},
	}, nil)
	body := readBody(t, res)
	if res.StatusCode != 400 || !strings.Contains(body, "敏感") {
		t.Fatalf("secret field %d %s", res.StatusCode, body)
	}

	res = doJSON(t, srv, "POST", "/v1/import/preview", map[string]any{
		"bundle": map[string]any{
			"schemaVersion": 1, "kind": "other", "sourceId": "src_x",
			"nodes": []map[string]any{{"id": "nde_a", "name": "n"}},
		},
	}, nil)
	if res.StatusCode != 400 {
		t.Fatalf("kind %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)

	res = doJSON(t, srv, "POST", "/v1/import/preview", `{`, nil)
	if res.StatusCode != 400 {
		t.Fatalf("malformed %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)

	dup := ConfigBundle{
		SchemaVersion: 1, Kind: configBundleKind, SourceID: "src_aaaa",
		Nodes: []ExportNode{{ID: "nde_a", Name: "a"}, {ID: "nde_a", Name: "b"}},
	}
	res = doJSON(t, srv, "POST", "/v1/import/preview", map[string]any{"bundle": dup}, nil)
	if res.StatusCode != 400 {
		t.Fatalf("dup %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)
}

func TestImportPersistFailureRollsBack(t *testing.T) {
	_, srcSrv, _ := newTestConsole(t)
	dst, dstSrv, _ := newTestConsole(t)
	nodeID, _ := testCreateNode(t, srcSrv, "n1")
	testCreateMapping(t, srcSrv, nodeID, "web", "tcp", "visitor", 0, 8080)
	bundle := testExport(t, srcSrv, nodeID)

	afterTombHook = func() error { return errPersist }
	t.Cleanup(func() { afterTombHook = nil })
	res, out := testImport(t, dstSrv, bundle, []map[string]any{{"originNodeId": nodeID, "action": "create"}})
	if res.StatusCode != 500 {
		t.Fatalf("status %d %s", res.StatusCode, out)
	}
	if len(dst.nodes) != 0 || len(dst.maps) != 0 || len(dst.nodeOrigins) != 0 {
		t.Fatal("persist failure left partial import")
	}
}

func TestImportOfflineNodeAndDisabledService(t *testing.T) {
	_, srcSrv, _ := newTestConsole(t)
	dst, dstSrv, _ := newTestConsole(t)
	srcNode, _ := testCreateNode(t, srcSrv, "src")
	disabled := testCreateMapping(t, srcSrv, srcNode, "off", "tcp", "public", 21000, 22)
	doJSON(t, srcSrv, "POST", "/v1/mappings/"+disabled+"/enabled", map[string]any{"enabled": false}, nil).Body.Close()
	testCreateMapping(t, srcSrv, srcNode, "on", "tcp", "visitor", 0, 22)
	bundle := testExport(t, srcSrv, srcNode)

	target, _ := testCreateNode(t, dstSrv, "offline-target")
	res, out := testImport(t, dstSrv, bundle, []map[string]any{{
		"originNodeId": srcNode, "action": "bind", "localNodeId": target,
	}})
	if res.StatusCode != 200 {
		t.Fatal(out)
	}
	var imported importResult
	if err := json.Unmarshal([]byte(out), &imported); err != nil {
		t.Fatal(err)
	}
	if !imported.Saved {
		t.Fatal(out)
	}
	foundDisabled := false
	foundPending := false
	dst.mu.Lock()
	for _, s := range imported.Services {
		if s.Action != "create" {
			continue
		}
		m := dst.maps[s.LocalID]
		if m != nil && !m.Spec.Enabled {
			foundDisabled = true
			if s.Result != "saved" {
				dst.mu.Unlock()
				t.Fatalf("disabled result %s", s.Result)
			}
		}
		if m != nil && m.Spec.Enabled && s.Result == "pending_push" {
			foundPending = true
		}
	}
	dst.mu.Unlock()
	if !foundDisabled || !foundPending {
		t.Fatalf("offline/disabled results: %s", out)
	}
}

func TestImportRequiresAuthAndDoesNotUseSourceIDs(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	c.SkipAuth = false
	res := doJSON(t, srv, "POST", "/v1/export", map[string]any{"nodes": []any{}}, nil)
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("export auth %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)
	res = doJSON(t, srv, "POST", "/v1/import/preview", map[string]any{"bundle": map[string]any{}}, nil)
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("preview auth %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)
}

func TestExportSelectedServicesOnly(t *testing.T) {
	_, srv, _ := newTestConsole(t)
	nodeID, _ := testCreateNode(t, srv, "n1")
	keep := testCreateMapping(t, srv, nodeID, "keep", "tcp", "visitor", 0, 1)
	drop := testCreateMapping(t, srv, nodeID, "drop", "tcp", "visitor", 0, 2)
	res := doJSON(t, srv, "POST", "/v1/export", map[string]any{
		"nodes": []map[string]any{{"id": nodeID, "serviceIds": []string{keep}}},
	}, nil)
	body := readBody(t, res)
	if res.StatusCode != 200 {
		t.Fatal(body)
	}
	var bundle ConfigBundle
	if err := json.Unmarshal([]byte(body), &bundle); err != nil {
		t.Fatal(err)
	}
	if len(bundle.Services) != 1 || bundle.Services[0].ID != keep {
		t.Fatalf("%+v", bundle.Services)
	}
	if bundle.Services[0].ID == drop {
		t.Fatal("dropped service exported")
	}
}

func TestImportDoesNotTakeOverUnrelatedOrDeleteMissing(t *testing.T) {
	_, srcSrv, _ := newTestConsole(t)
	dst, dstSrv, _ := newTestConsole(t)
	srcNode, _ := testCreateNode(t, srcSrv, "src")
	testCreateMapping(t, srcSrv, srcNode, "from-src", "tcp", "visitor", 0, 22)
	bundle := testExport(t, srcSrv, srcNode)

	target, _ := testCreateNode(t, dstSrv, "target")
	local := testCreateMapping(t, dstSrv, target, "unrelated", "tcp", "visitor", 0, 33)
	res, out := testImport(t, dstSrv, bundle, []map[string]any{{
		"originNodeId": srcNode, "action": "bind", "localNodeId": target,
	}})
	if res.StatusCode != 200 {
		t.Fatal(out)
	}
	dst.mu.Lock()
	defer dst.mu.Unlock()
	if dst.maps[local] == nil {
		t.Fatal("unrelated local service deleted")
	}
	if len(dst.maps) != 2 {
		t.Fatalf("want unrelated kept plus imported, got %d", len(dst.maps))
	}
}

func TestImportVisitorRejectsEntryPortAndRevokedBind(t *testing.T) {
	_, srcSrv, _ := newTestConsole(t)
	_, dstSrv, _ := newTestConsole(t)
	srcNode, _ := testCreateNode(t, srcSrv, "src")
	testCreateMapping(t, srcSrv, srcNode, "v", "tcp", "visitor", 0, 22)
	bundle := testExport(t, srcSrv, srcNode)
	p := 22
	bundle.Services[0].EntryPort = &p
	res, out := testImport(t, dstSrv, bundle, []map[string]any{{"originNodeId": srcNode, "action": "create"}})
	if res.StatusCode != 400 {
		t.Fatalf("visitor port %d %s", res.StatusCode, out)
	}

	bundle = testExport(t, srcSrv, srcNode)
	revoked, _ := testCreateNode(t, dstSrv, "revoked")
	res = doJSON(t, dstSrv, "POST", "/v1/nodes/"+revoked+"/revoke", nil, nil)
	if res.StatusCode != 204 {
		t.Fatal(readBody(t, res))
	}
	readBody(t, res)
	res, out = testImport(t, dstSrv, bundle, []map[string]any{{
		"originNodeId": srcNode, "action": "bind", "localNodeId": revoked,
	}})
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("revoked %d %s", res.StatusCode, out)
	}
}

func TestManualCreateStillWorksAlongsideImport(t *testing.T) {
	_, srv, _ := newTestConsole(t)
	id, _ := testCreateNode(t, srv, "manual")
	mapID := testCreateMapping(t, srv, id, "svc", "tcp", "visitor", 0, 22)
	if mapID == "" {
		t.Fatal("manual mapping failed")
	}
}

func TestImportRoundTripIdleTimeoutAboveSPAMax(t *testing.T) {
	_, srcSrv, _ := newTestConsole(t)
	dst, dstSrv, _ := newTestConsole(t)
	nodeID, _ := testCreateNode(t, srcSrv, "n1")
	res := doJSON(t, srcSrv, "POST", "/v1/mappings", map[string]any{
		"nodeId": nodeID, "name": "long-idle", "proto": "tcp", "mode": "visitor",
		"localHost": "127.0.0.1", "localPort": 8080, "idleTimeoutSec": 172800,
	}, nil)
	body := readBody(t, res)
	if res.StatusCode != 200 {
		t.Fatal(body)
	}
	bundle := testExport(t, srcSrv, nodeID)
	if len(bundle.Services) != 1 || bundle.Services[0].IdleTimeoutSec != 172800 {
		t.Fatalf("%+v", bundle.Services)
	}
	res, out := testImport(t, dstSrv, bundle, []map[string]any{{"originNodeId": nodeID, "action": "create"}})
	if res.StatusCode != 200 {
		t.Fatalf("re-import %d %s", res.StatusCode, out)
	}
	var imported importResult
	if err := json.Unmarshal([]byte(out), &imported); err != nil {
		t.Fatal(err)
	}
	dst.mu.Lock()
	got := dst.maps[imported.Services[0].LocalID]
	if got == nil || got.Spec.IdleTimeoutSec != 172800 {
		dst.mu.Unlock()
		t.Fatalf("%+v", got)
	}
	dst.mu.Unlock()
}

func TestImportRoundTripMaxConnsAndRateAboveFormerCaps(t *testing.T) {
	_, srcSrv, _ := newTestConsole(t)
	dst, dstSrv, _ := newTestConsole(t)
	nodeID, _ := testCreateNode(t, srcSrv, "n1")
	res := doJSON(t, srcSrv, "POST", "/v1/mappings", map[string]any{
		"nodeId": nodeID, "name": "wide", "proto": "tcp", "mode": "visitor",
		"localHost": "127.0.0.1", "localPort": 8080,
		"maxConns": 2_000_000, "rateKbps": 20_000_000,
	}, nil)
	body := readBody(t, res)
	if res.StatusCode != 200 {
		t.Fatal(body)
	}
	bundle := testExport(t, srcSrv, nodeID)
	if len(bundle.Services) != 1 || bundle.Services[0].MaxConns != 2_000_000 || bundle.Services[0].RateKbps != 20_000_000 {
		t.Fatalf("%+v", bundle.Services)
	}
	res, out := testImport(t, dstSrv, bundle, []map[string]any{{"originNodeId": nodeID, "action": "create"}})
	if res.StatusCode != 200 {
		t.Fatalf("re-import %d %s", res.StatusCode, out)
	}
	var imported importResult
	if err := json.Unmarshal([]byte(out), &imported); err != nil {
		t.Fatal(err)
	}
	dst.mu.Lock()
	got := dst.maps[imported.Services[0].LocalID]
	if got == nil || got.Spec.MaxConns != 2_000_000 || got.Spec.RateKbps != 20_000_000 {
		dst.mu.Unlock()
		t.Fatalf("%+v", got)
	}
	dst.mu.Unlock()
}

func TestImportPreviewEmptyServicesIsArray(t *testing.T) {
	_, srcSrv, _ := newTestConsole(t)
	_, dstSrv, _ := newTestConsole(t)
	nodeID, _ := testCreateNode(t, srcSrv, "empty")
	bundle := testExport(t, srcSrv, nodeID)
	if len(bundle.Services) != 0 {
		t.Fatalf("%+v", bundle.Services)
	}
	res := doJSON(t, dstSrv, "POST", "/v1/import/preview", map[string]any{
		"bundle":   bundle,
		"bindings": []map[string]any{{"originNodeId": nodeID, "action": "create"}},
	}, nil)
	body := readBody(t, res)
	if res.StatusCode != 200 {
		t.Fatal(body)
	}
	if strings.Contains(body, `"services":null`) {
		t.Fatal(body)
	}
	var prev importPreview
	if err := json.Unmarshal([]byte(body), &prev); err != nil {
		t.Fatal(err)
	}
	if len(prev.Nodes) != 1 || prev.Nodes[0].Services == nil {
		t.Fatalf("empty node services must be []: %+v", prev.Nodes)
	}
}

func TestExportUsesStableSourceID(t *testing.T) {
	_, srv, _ := newTestConsole(t)
	id, _ := testCreateNode(t, srv, "n")
	a := testExport(t, srv, id)
	b := testExport(t, srv, id)
	if a.SourceID == "" || a.SourceID != b.SourceID {
		t.Fatalf("%s vs %s", a.SourceID, b.SourceID)
	}
}

func TestPortsConflictIgnoresSkippedAndDisabled(t *testing.T) {
	c, _, _ := newTestConsole(t)
	port := 443
	c.maps["keep"] = &mapRec{Spec: wire.Mapping{ID: "keep", Proto: "tcp", Mode: "public", EntryPort: &port, Enabled: true}}
	planned := []wire.Mapping{{ID: "keep", Proto: "tcp", Mode: "public", EntryPort: &port, Enabled: true}}
	if err := c.portsConflictLocked(planned, map[string]struct{}{"keep": {}}); err != nil {
		t.Fatal(err)
	}
	disabled := []wire.Mapping{{Proto: "tcp", Mode: "public", EntryPort: &port, Enabled: false}}
	if err := c.portsConflictLocked(disabled, nil); err != nil {
		t.Fatal(err)
	}
}
