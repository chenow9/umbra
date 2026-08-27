package control

import (
	"embed"
	"encoding/json"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path"
	"strconv"
	"strings"
	"time"

	"umbra/internal/wire"
)

//go:embed all:ui
var uiFS embed.FS

func (c *Console) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc("GET /v1/auth", c.getAuth)
	mux.HandleFunc("POST /v1/setup", c.postSetup)
	mux.HandleFunc("POST /v1/login", c.postLogin)
	mux.HandleFunc("POST /v1/logout", c.postLogout)

	mux.HandleFunc("GET /v1/overview", c.need(c.getOverview))
	mux.HandleFunc("GET /v1/agents", c.need(c.getAgents))
	mux.HandleFunc("POST /v1/agents", c.need(c.postAgent))
	mux.HandleFunc("GET /v1/agents/{id}/bootstrap", c.need(c.getBootstrap))
	mux.HandleFunc("POST /v1/agents/{id}/hello", c.need(c.postHello))
	mux.HandleFunc("POST /v1/agents/{id}/disconnect", c.need(c.postDisconnect))
	mux.HandleFunc("POST /v1/agents/{id}/revoke", c.need(c.postRevoke))
	mux.HandleFunc("GET /v1/mappings", c.need(c.getMappings))
	mux.HandleFunc("POST /v1/mappings", c.need(c.postMapping))
	mux.HandleFunc("POST /v1/mappings/{id}/enabled", c.need(c.postEnabled))
	mux.HandleFunc("POST /v1/mappings/{id}/delete", c.need(c.postDeleteMap))
	mux.HandleFunc("POST /v1/mappings/{id}/knock", c.need(c.postKnock))
	mux.HandleFunc("POST /v1/mappings/{id}/probe", c.need(c.postProbe))
	mux.HandleFunc("POST /v1/mappings/{id}/visit", c.need(c.postVisit))
	mux.HandleFunc("POST /v1/mappings/{id}/visitor", c.need(c.postVisitor))
	mux.HandleFunc("GET /v1/audit", c.need(c.getAudit))
	mux.HandleFunc("GET /v1/frames", c.need(c.getFrames))
	mux.HandleFunc("GET /v1/traffic", c.need(c.getTraffic))
	mux.HandleFunc("POST /v1/demo", c.need(c.postDemo))

	mux.HandleFunc("GET /v1/status", c.need(c.getStatus))
	mux.HandleFunc("PUT /v1/tokens/{token}", c.need(c.putToken))
	mux.HandleFunc("PUT /v1/agents/{id}/mappings", c.need(c.putMaps))
	mux.HandleFunc("POST /v1/knock/{id}", c.need(c.postKnockRaw))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" || strings.HasPrefix(r.URL.Path, "/v1/") {
			mux.ServeHTTP(w, r)
			return
		}
		c.serveUI(w, r)
	})
}

func (c *Console) serveUI(w http.ResponseWriter, r *http.Request) {
	if c.UIUpstream != "" {
		u, err := url.Parse(c.UIUpstream)
		if err == nil && u.Host != "" {
			p := httputil.NewSingleHostReverseProxy(u)
			p.FlushInterval = 50 * time.Millisecond
			r.Host = u.Host
			p.ServeHTTP(w, r)
			return
		}
	}
	p := path.Clean(r.URL.Path)
	if p == "." || p == "" {
		p = "/"
	}
	if c.UIDir != "" {
		fp := path.Join(c.UIDir, p)
		if p == "/" {
			fp = path.Join(c.UIDir, "index.html")
		}
		if st, err := os.Stat(fp); err == nil && !st.IsDir() {
			http.ServeFile(w, r, fp)
			return
		}
		http.ServeFile(w, r, path.Join(c.UIDir, "index.html"))
		return
	}
	sub, err := fs.Sub(uiFS, "ui")
	if err != nil {
		http.NotFound(w, r)
		return
	}
	rel := strings.TrimPrefix(p, "/")
	if rel == "" || rel == "." || strings.HasSuffix(rel, "/") {
		rel = "index.html"
	}
	if _, err := fs.Stat(sub, rel); err != nil {
		rel = "index.html"
	}
	http.ServeFileFS(w, r, sub, rel)
}

func (c *Console) need(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if c.SkipAuth {
			h(w, r)
			return
		}
		ck, _ := r.Cookie("umbra_owner")
		raw := ""
		if ck != nil {
			raw = ck.Value
		}
		if !c.validCookie(raw) {
			http.Error(w, `{"error":"需要登录"}`, http.StatusUnauthorized)
			return
		}
		h(w, r)
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func readJSON(r *http.Request, v any) error {
	defer r.Body.Close()
	return json.NewDecoder(r.Body).Decode(v)
}

func (c *Console) getAuth(w http.ResponseWriter, r *http.Request) {
	ck, _ := r.Cookie("umbra_owner")
	raw := ""
	if ck != nil {
		raw = ck.Value
	}
	writeJSON(w, c.authStatus(raw))
}

func (c *Console) postSetup(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Password string `json:"password"`
	}
	_ = readJSON(r, &b)
	if err := c.setup(b.Password); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	c.setCookie(w, r)
	writeJSON(w, map[string]any{"ok": true})
}

func (c *Console) postLogin(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Password string `json:"password"`
	}
	_ = readJSON(r, &b)
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	if err := c.login(b.Password, ip); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	c.setCookie(w, r)
	writeJSON(w, map[string]any{"ok": true})
}

func (c *Console) postLogout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: "umbra_owner", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode})
	writeJSON(w, map[string]any{"ok": true})
}

func (c *Console) setCookie(w http.ResponseWriter, r *http.Request) {
	secure := r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
	http.SetCookie(w, &http.Cookie{
		Name: "umbra_owner", Value: c.cookieValue(), Path: "/", HttpOnly: true,
		SameSite: http.SameSiteLaxMode, MaxAge: 7 * 24 * 3600, Secure: secure,
	})
}

func (c *Console) live() map[string]gateAgent {
	st := c.Gate.Status()
	out := map[string]gateAgent{}
	for _, a := range st.Agents {
		out[a.ID] = gateAgent{Online: a.Online, Addr: a.Addr, OS: a.OS, Arch: a.Arch, Ver: a.Ver}
	}
	return out
}

type gateAgent struct {
	Online              bool
	Addr, OS, Arch, Ver string
}

func (c *Console) getAgents(w http.ResponseWriter, _ *http.Request) {
	live := c.live()
	stats := c.Gate.MappingStats()
	c.mu.Lock()
	defer c.mu.Unlock()
	out := []map[string]any{}
	for _, a := range c.agents {
		st := a.Status
		addr, ver, os, arch := a.Addr, a.Version, a.OS, a.Arch
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
		n, in, outB := 0, int64(0), int64(0)
		for _, m := range c.maps {
			if m.AgentID == a.ID {
				n++
				if s, ok := stats[m.Spec.ID]; ok {
					in += s.In
					outB += s.Out
				} else {
					in += m.BytesIn
					outB += m.BytesOut
				}
			}
		}
		last := ""
		if a.LastSeen != nil {
			last = a.LastSeen.UTC().Format(time.RFC3339)
		}
		out = append(out, map[string]any{
			"id": a.ID, "name": a.Name, "comment": a.Comment, "status": st,
			"addr": addr, "version": ver, "os": os, "arch": arch,
			"lastSeen": last, "enabled": a.Enabled && a.Status != "revoked",
			"createdAt":    a.Created.UTC().Format(time.RFC3339),
			"mappingCount": n, "bytesIn": in, "bytesOut": outB,
		})
	}
	writeJSON(w, out)
}

func (c *Console) postAgent(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Name, Comment, OS, Arch string
	}
	if err := readJSON(r, &b); err != nil {
		writeErr(w, 400, "bad json")
		return
	}
	if strings.TrimSpace(b.Name) == "" {
		writeErr(w, 400, "需要名称")
		return
	}
	id := newID("agt")
	tok := "umbra_boot_" + newID("t")[2:]
	c.mu.Lock()
	rec := &agentRec{
		ID: id, Name: strings.TrimSpace(b.Name), Comment: strings.TrimSpace(b.Comment),
		OS: b.OS, Arch: b.Arch, Token: tok, Status: "offline", Enabled: true, Created: time.Now(),
	}
	c.agents[id] = rec
	c.Gate.SetToken(tok, id)
	c.logAudit("agent.create", id, rec.Name+" "+rec.OS+"/"+rec.Arch)
	c.save()
	c.mu.Unlock()
	writeJSON(w, map[string]any{"id": id, "token": tok, "os": rec.OS, "arch": rec.Arch})
}

func (c *Console) getBootstrap(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	c.mu.Lock()
	a := c.agents[id]
	c.mu.Unlock()
	if a == nil || a.Status == "revoked" || a.Token == "" {
		writeErr(w, 404, "没有可用凭证")
		return
	}
	writeJSON(w, map[string]any{"token": a.Token})
}

func (c *Console) postHello(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	c.mu.Lock()
	a := c.agents[id]
	tok := ""
	if a != nil {
		tok = a.Token
	}
	c.mu.Unlock()
	if a == nil {
		writeErr(w, 404, "节点不存在")
		return
	}
	if tok != "" {
		c.spawnAgent(tok)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if g, ok := c.live()[id]; ok && g.Online {
			break
		}
		time.Sleep(80 * time.Millisecond)
	}
	c.push(id)
	n := 0
	c.mu.Lock()
	for _, m := range c.maps {
		if m.AgentID == id && m.Spec.Enabled {
			n++
		}
	}
	if a := c.agents[id]; a != nil {
		now := time.Now()
		a.LastSeen = &now
	}
	c.logFrame(id, "c2s", "Hello", "hello")
	c.logFrame(id, "s2c", "HelloOk", "mappings pushed")
	c.logAudit("agent.hello", id, "HelloOk")
	c.save()
	c.mu.Unlock()
	writeJSON(w, map[string]any{"ok": true, "pushed": n})
}

func (c *Console) postDisconnect(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	c.Gate.Disconnect(id)
	c.mu.Lock()
	c.logAudit("agent.disconnect", id, "")
	c.save()
	c.mu.Unlock()
	w.WriteHeader(204)
}

func (c *Console) postRevoke(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	c.Gate.Revoke(id)
	c.mu.Lock()
	if a := c.agents[id]; a != nil {
		a.Status = "revoked"
		a.Enabled = false
		a.Token = ""
	}
	c.logAudit("agent.revoke", id, "")
	c.save()
	c.mu.Unlock()
	w.WriteHeader(204)
}

func (c *Console) getMappings(w http.ResponseWriter, _ *http.Request) {
	live := c.live()
	stats := c.Gate.MappingStats()
	c.mu.Lock()
	defer c.mu.Unlock()
	out := []map[string]any{}
	for _, m := range c.maps {
		a := c.agents[m.AgentID]
		name, ast := "", "offline"
		if a != nil {
			name, ast = a.Name, a.Status
			if g, ok := live[a.ID]; ok && g.Online && a.Status != "revoked" {
				ast = "online"
			}
		}
		in, outB, active := m.BytesIn, m.BytesOut, 0
		if s, ok := stats[m.Spec.ID]; ok {
			in, outB, active = s.In, s.Out, s.Active
		}
		port := any(nil)
		if m.Spec.EntryPort != nil {
			port = *m.Spec.EntryPort
		}
		listen, push := m.ListenState, m.PushState
		if ast == "online" && m.Spec.Enabled {
			if m.Spec.Mode == "visitor" {
				listen = "ready"
			} else {
				listen = "listening"
			}
			push = "acked"
		}
		grant := ""
		last := ""
		if m.LastProbe != nil {
			last = m.LastProbe.UTC().Format(time.RFC3339)
		}
		out = append(out, map[string]any{
			"id": m.Spec.ID, "agentId": m.AgentID, "agentName": name, "agentStatus": ast,
			"name": m.Spec.Name, "proto": m.Spec.Proto, "mode": m.Spec.Mode,
			"entryPort": port, "localHost": m.Spec.LocalHost, "localPort": m.Spec.LocalPort,
			"enabled": m.Spec.Enabled, "listenState": listen, "listenError": nilIfEmpty(m.ListenError),
			"pushState": push, "bytesIn": in, "bytesOut": outB, "activeConns": active,
			"lastProbeAt": last, "lastProbePreview": m.LastPreview, "grantUntil": grant,
			"maxConns": m.Spec.MaxConns, "rateKbps": m.Spec.RateKbps, "allowCidrs": m.Spec.AllowCidrs,
			"createdAt": m.Created.UTC().Format(time.RFC3339),
			"updatedAt": m.Updated.UTC().Format(time.RFC3339),
		})
	}
	writeJSON(w, out)
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func (c *Console) postMapping(w http.ResponseWriter, r *http.Request) {
	var b struct {
		AgentID    string `json:"agentId"`
		Name       string `json:"name"`
		Proto      string `json:"proto"`
		Mode       string `json:"mode"`
		EntryPort  *int   `json:"entryPort"`
		LocalHost  string `json:"localHost"`
		LocalPort  int    `json:"localPort"`
		MaxConns   int    `json:"maxConns"`
		RateKbps   int    `json:"rateKbps"`
		AllowCidrs string `json:"allowCidrs"`
	}
	if err := readJSON(r, &b); err != nil {
		writeErr(w, 400, "bad json")
		return
	}
	if b.Mode != "visitor" && b.EntryPort == nil {
		writeErr(w, 400, "公开或暗端口模式必须指定入口端口")
		return
	}
	id := newID("map")
	max := b.MaxConns
	if max == 0 {
		max = 64
	}
	spec := wire.Mapping{
		ID: id, Name: strings.TrimSpace(b.Name), Proto: b.Proto, Mode: b.Mode,
		EntryPort: b.EntryPort, LocalHost: strings.TrimSpace(b.LocalHost), LocalPort: b.LocalPort,
		Enabled: true, MaxConns: max, RateKbps: b.RateKbps, AllowCidrs: b.AllowCidrs, IdleTimeoutSec: 60,
	}
	now := time.Now()
	c.mu.Lock()
	if c.agents[b.AgentID] == nil {
		c.mu.Unlock()
		writeErr(w, 404, "节点不存在")
		return
	}
	c.maps[id] = &mapRec{Spec: spec, AgentID: b.AgentID, ListenState: "pending", PushState: "pending_offline", Created: now, Updated: now}
	c.logAudit("mapping.create", id, spec.Name)
	c.save()
	c.mu.Unlock()
	c.push(b.AgentID)
	writeJSON(w, map[string]any{"id": id, "agentId": b.AgentID, "name": spec.Name})
}

func (c *Console) postEnabled(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Enabled bool `json:"enabled"`
	}
	_ = readJSON(r, &b)
	id := r.PathValue("id")
	c.mu.Lock()
	m := c.maps[id]
	if m == nil {
		c.mu.Unlock()
		writeErr(w, 404, "映射不存在")
		return
	}
	m.Spec.Enabled = b.Enabled
	m.Updated = time.Now()
	aid := m.AgentID
	c.save()
	c.mu.Unlock()
	c.push(aid)
	writeJSON(w, map[string]any{"ok": true})
}

func (c *Console) postDeleteMap(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	c.mu.Lock()
	m := c.maps[id]
	if m == nil {
		c.mu.Unlock()
		writeErr(w, 404, "映射不存在")
		return
	}
	aid := m.AgentID
	delete(c.maps, id)
	c.logAudit("mapping.delete", id, "")
	c.save()
	c.mu.Unlock()
	c.push(aid)
	writeJSON(w, map[string]any{"ok": true})
}

func (c *Console) postKnock(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	until := c.Gate.Knock(id, 60*time.Second)
	c.mu.Lock()
	c.logAudit("mapping.knock", id, "SPA grant 60s")
	c.mu.Unlock()
	writeJSON(w, map[string]any{"until": until.UTC().Format(time.RFC3339)})
}

func (c *Console) postKnockRaw(w http.ResponseWriter, r *http.Request) {
	c.postKnock(w, r)
}

func (c *Console) postProbe(w http.ResponseWriter, r *http.Request) {
	c.probe(w, r, false)
}

func (c *Console) postVisit(w http.ResponseWriter, r *http.Request) {
	c.probe(w, r, true)
}

func (c *Console) probe(w http.ResponseWriter, r *http.Request, visit bool) {
	id := r.PathValue("id")
	c.mu.Lock()
	m := c.maps[id]
	c.mu.Unlock()
	if m == nil {
		writeErr(w, 404, "映射不存在")
		return
	}
	if m.Spec.Mode == "spa" {
		c.Gate.Knock(id, 60*time.Second)
		time.Sleep(50 * time.Millisecond)
	}
	if m.Spec.EntryPort == nil {
		writeErr(w, 400, "访客模式没有入口端口")
		return
	}
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(*m.Spec.EntryPort))
	conn, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	defer conn.Close()
	payload := []byte("umbra-probe " + id + "\n")
	_, _ = conn.Write(payload)
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 256)
	n, _ := conn.Read(buf)
	preview := string(buf[:n])
	now := time.Now()
	c.mu.Lock()
	m.LastProbe = &now
	m.LastPreview = preview
	m.BytesIn += int64(n)
	m.BytesOut += int64(len(payload))
	c.mu.Unlock()
	writeJSON(w, map[string]any{"bytesIn": n, "bytesOut": len(payload), "preview": preview})
}

func (c *Console) postVisitor(w http.ResponseWriter, _ *http.Request) {
	id := newID("vis")
	ticket := "umbra_vis_" + newID("k")[2:]
	writeJSON(w, map[string]any{
		"id": id, "ticket": ticket,
		"visitCmd":  "umbra visit --gate gate:4400 --ticket " + ticket + " --local 2222",
		"expiresAt": time.Now().Add(24 * time.Hour).UTC().Format(time.RFC3339),
	})
}

func (c *Console) getAudit(w http.ResponseWriter, _ *http.Request) {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]map[string]any, 0, len(c.audit))
	for i := len(c.audit) - 1; i >= 0; i-- {
		a := c.audit[i]
		out = append(out, map[string]any{
			"id": a.ID, "ts": a.Ts.UTC().Format(time.RFC3339),
			"actor": a.Actor, "action": a.Action, "target": a.Target, "detail": a.Detail,
		})
	}
	writeJSON(w, out)
}

func (c *Console) getFrames(w http.ResponseWriter, _ *http.Request) {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := []frameRec{}
	out = append(out, c.frames...)
	writeJSON(w, out)
}

func (c *Console) getTraffic(w http.ResponseWriter, r *http.Request) {
	c.mu.Lock()
	defer c.mu.Unlock()
	series := []map[string]any{}
	var in, out int64
	for _, s := range c.samples {
		series = append(series, map[string]any{"ts": s.Ts.UTC().Format(time.RFC3339), "bytesIn": s.In, "bytesOut": s.Out})
		in += s.In
		out += s.Out
	}
	writeJSON(w, map[string]any{"bytesIn": in, "bytesOut": out, "peakBpsIn": 0, "peakBpsOut": 0, "series": series})
}

func (c *Console) getOverview(w http.ResponseWriter, _ *http.Request) {
	live := c.live()
	c.mu.Lock()
	defer c.mu.Unlock()
	online, total := 0, len(c.agents)
	for _, a := range c.agents {
		if g, ok := live[a.ID]; ok && g.Online && a.Status != "revoked" {
			online++
		}
	}
	active, maps := 0, len(c.maps)
	for _, m := range c.maps {
		if m.Spec.Enabled {
			active++
		}
	}
	recent := []map[string]any{}
	for i := len(c.audit) - 1; i >= 0 && len(recent) < 8; i-- {
		a := c.audit[i]
		recent = append(recent, map[string]any{
			"id": a.ID, "ts": a.Ts.UTC().Format(time.RFC3339),
			"actor": a.Actor, "action": a.Action, "target": a.Target, "detail": a.Detail,
		})
	}
	writeJSON(w, map[string]any{
		"agentsOnline": online, "agentsTotal": total,
		"mappingsActive": active, "mappingsTotal": maps,
		"bytesInToday": 0, "bytesOutToday": 0, "bpsIn": 0, "bpsOut": 0,
		"recentAudit": recent,
	})
}

func (c *Console) getStatus(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, c.Gate.Status())
}

func (c *Console) putToken(w http.ResponseWriter, r *http.Request) {
	var b struct {
		AgentID string `json:"agent_id"`
	}
	_ = readJSON(r, &b)
	c.Gate.SetToken(r.PathValue("token"), b.AgentID)
	w.WriteHeader(204)
}

func (c *Console) putMaps(w http.ResponseWriter, r *http.Request) {
	var maps []wire.Mapping
	if err := json.NewDecoder(r.Body).Decode(&maps); err != nil && err != io.EOF {
		writeErr(w, 400, err.Error())
		return
	}
	id := r.PathValue("id")
	c.Gate.PutMappings(id, maps)
	c.mu.Lock()
	now := time.Now()
	for _, spec := range maps {
		if existing := c.maps[spec.ID]; existing != nil {
			existing.Spec = spec
			existing.Updated = now
		} else {
			c.maps[spec.ID] = &mapRec{Spec: spec, AgentID: id, Created: now, Updated: now}
		}
	}
	c.save()
	c.mu.Unlock()
	w.WriteHeader(204)
}

func (c *Console) postDemo(w http.ResponseWriter, _ *http.Request) {
	c.mu.Lock()
	var demo *agentRec
	for _, a := range c.agents {
		if a.Name == "演示节点" && a.Status != "revoked" {
			demo = a
			break
		}
	}
	if demo == nil {
		id := newID("agt")
		tok := "umbra_boot_" + newID("t")[2:]
		demo = &agentRec{ID: id, Name: "演示节点", Comment: "本机演示", OS: "linux", Arch: "amd64", Token: tok, Status: "offline", Enabled: true, Created: time.Now()}
		c.agents[id] = demo
		c.Gate.SetToken(tok, id)
	}
	tok := demo.Token
	aid := demo.ID
	c.mu.Unlock()
	c.spawnAgent(tok)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if g, ok := c.live()[aid]; ok && g.Online {
			break
		}
		time.Sleep(80 * time.Millisecond)
	}
	c.push(aid)
	writeJSON(w, map[string]any{
		"agentId": aid, "mappingId": "", "bytesIn": 0, "bytesOut": 0,
		"preview": "", "dropped": true, "udpBytesIn": 0, "udpBytesOut": 0,
	})
}

func (c *Console) push(agentID string) {
	c.mu.Lock()
	var maps []wire.Mapping
	for _, m := range c.maps {
		if m.AgentID == agentID {
			maps = append(maps, m.Spec)
		}
	}
	c.mu.Unlock()
	c.Gate.PutMappings(agentID, maps)
}
