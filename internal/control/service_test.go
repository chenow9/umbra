package control

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"umbra/internal/gate"
	"umbra/internal/wire"
)

func TestServiceEntryAddress(t *testing.T) {
	port := 22022
	for _, tc := range []struct{ advertise, mode, want string }{
		{"gate.example.com:4400", "public", "gate.example.com:22022"},
		{"[2001:db8::1]:4400", "spa", "[2001:db8::1]:22022"},
		{"gate.example.com:4400", "visitor", ""},
		{":4400", "public", ""},
		{"0.0.0.0:4400", "public", ""},
		{"[::]:4400", "public", ""},
		{"invalid", "public", ""},
	} {
		if got := serviceEntryAddress(tc.advertise, tc.mode, &port); got != tc.want {
			t.Errorf("%+v: got %q", tc, got)
		}
	}
	if serviceEntryAddress("gate.example.com:4400", "public", nil) != "" {
		t.Fatal("missing port must not yield an address")
	}
}

func TestServiceReadinessRequiresAcknowledgement(t *testing.T) {
	for _, tc := range []struct {
		mode, push, want string
		active           int
	}{
		{"visitor", "pending", "pending", 0},
		{"visitor", "acked", "visitor", 0},
		{"visitor", "acked", "full", 8},
	} {
		if got := mappingReach(true, tc.mode, "ready", tc.push, "online", "", false, tc.active, 8); got != tc.want {
			t.Errorf("%+v: got %s", tc, got)
		}
	}
}

func TestOverviewDoesNotCountUnconfirmedOrBrokenServices(t *testing.T) {
	c, _, _ := newTestConsole(t)
	c.nodes["node"] = &nodeRec{ID: "node", Name: "node", Enabled: true}
	for _, id := range []string{"ready", "pending", "broken"} {
		c.maps[id] = &mapRec{NodeID: "node", Spec: wire.Mapping{ID: id, Mode: "visitor", Enabled: true}}
	}
	live := map[string]gateNode{"node": {Online: true}}
	stats := map[string]gate.MapStat{"ready": {Acked: true}, "pending": {}, "broken": {Error: "failed"}}
	if got := c.overviewView(live, stats)["mappingsActive"]; got != 1 {
		t.Fatalf("got %v ready services, want 1", got)
	}
}

func TestProbeRequiresResponseAndRecordsFailure(t *testing.T) {
	for _, tc := range []struct {
		name, response string
		status         int
	}{
		{"response", "hello", http.StatusOK},
		{"closed_without_response", "", http.StatusBadRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, srv, _ := newTestConsole(t)
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			done := make(chan struct{})
			go func() {
				defer close(done)
				conn, err := listener.Accept()
				if err != nil {
					return
				}
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
				buf := make([]byte, 256)
				_, _ = conn.Read(buf)
				if tc.response != "" {
					_, _ = conn.Write([]byte(tc.response))
				}
			}()
			port := listener.Addr().(*net.TCPAddr).Port
			c.maps["probe"] = &mapRec{Spec: wire.Mapping{ID: "probe", Proto: "tcp", Mode: "public", EntryPort: &port, Enabled: true}}
			res := doJSON(t, srv, "POST", "/v1/mappings/probe/probe", nil, nil)
			body := readBody(t, res)
			if res.StatusCode != tc.status {
				t.Fatalf("status %d: %s", res.StatusCode, body)
			}
			c.mu.Lock()
			recorded := c.maps["probe"]
			if recorded.LastProbe == nil {
				t.Error("probe attempt not recorded")
			}
			if tc.response == "" && recorded.LastProbeError == "" {
				t.Error("failed probe recorded as success")
			}
			if tc.response != "" && recorded.LastProbeError != "" {
				t.Error(recorded.LastProbeError)
			}
			c.mu.Unlock()
			if tc.response != "" {
				var result map[string]any
				if err := json.Unmarshal([]byte(body), &result); err != nil {
					t.Fatal(err)
				}
				if result["bytesIn"] != float64(len(tc.response)) {
					t.Fatal(result)
				}
			} else if !strings.Contains(body, "未验证目标响应") {
				t.Fatal(body)
			}
			<-done
		})
	}
}

func TestDisabledProbeDoesNotDial(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	c.maps["disabled"] = &mapRec{Spec: wire.Mapping{ID: "disabled", Proto: "tcp", Mode: "public"}}
	res := doJSON(t, srv, "POST", "/v1/mappings/disabled/probe", nil, nil)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatal(readBody(t, res))
	}
	if !strings.Contains(readBody(t, res), "已停用") {
		t.Fatal("missing disabled explanation")
	}
}

func TestCreateServiceReturnsFullViewAndRejectsRevokedNode(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	c.nodes["node"] = &nodeRec{ID: "node", Name: "QA", Enabled: true}
	payload := map[string]any{"nodeId": "node", "name": "private", "proto": "tcp", "mode": "visitor", "localHost": "127.0.0.1", "localPort": 22}
	res := doJSON(t, srv, "POST", "/v1/mappings", payload, nil)
	body := readBody(t, res)
	if res.StatusCode != 200 {
		t.Fatal(body)
	}
	var view map[string]any
	if err := json.Unmarshal([]byte(body), &view); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"id", "mode", "proto", "enabled", "nodeStatus", "pushState", "listenState", "localPort", "entryAddress"} {
		if _, ok := view[key]; !ok {
			t.Errorf("create response is missing %s", key)
		}
	}
	c.mu.Lock()
	c.nodes["node"].Status = "revoked"
	c.nodes["node"].Enabled = false
	c.mu.Unlock()
	res = doJSON(t, srv, "POST", "/v1/mappings", payload, nil)
	if res.StatusCode != 400 {
		t.Fatal(readBody(t, res))
	}
	if !strings.Contains(readBody(t, res), "吊销") {
		t.Fatal("missing revoked node explanation")
	}
}

func TestProbeDoesNotAttributeOldResponseToNewConfiguration(t *testing.T) {
	c, _, _ := newTestConsole(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	received, release := make(chan struct{}), make(chan struct{})
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
		buf := make([]byte, 256)
		_, _ = conn.Read(buf)
		close(received)
		<-release
		_, _ = conn.Write([]byte("old response"))
	}()
	port := listener.Addr().(*net.TCPAddr).Port
	c.maps["changing"] = &mapRec{Spec: wire.Mapping{ID: "changing", Proto: "tcp", Mode: "public", EntryPort: &port, Enabled: true, Generation: 1}}
	req := httptest.NewRequest("POST", "/v1/mappings/changing/probe", nil)
	req.SetPathValue("id", "changing")
	result := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { c.probe(result, req, false); close(done) }()
	select {
	case <-received:
	case <-time.After(3 * time.Second):
		close(release)
		t.Fatal("probe not sent")
	}
	c.mu.Lock()
	c.maps["changing"].Spec.Generation++
	c.mu.Unlock()
	close(release)
	<-done
	if result.Code != 409 {
		t.Fatalf("old response accepted: %d %s", result.Code, result.Body.String())
	}
	if c.maps["changing"].LastProbe != nil {
		t.Fatal("old response recorded against new configuration")
	}
}
