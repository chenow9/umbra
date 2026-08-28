package control

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
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

	"umbra/internal/gate"
	"umbra/internal/wire"
)

const jsonBodyLimit = 256 << 10

//go:embed all:ui
var uiFS embed.FS

func (c *Console) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", c.getHealth)
	mux.HandleFunc("GET /v1/auth", c.getAuth)
	mux.HandleFunc("POST /v1/setup", c.postSetup)
	mux.HandleFunc("POST /v1/login", c.postLogin)
	mux.HandleFunc("POST /v1/logout", c.postLogout)
	mux.HandleFunc("POST /v1/logout-all", c.need(c.postLogoutAll))
	mux.HandleFunc("POST /v1/password", c.need(c.postPassword))

	mux.HandleFunc("GET /v1/overview", c.need(c.getOverview))
	mux.HandleFunc("GET /v1/nodes", c.need(c.getNodes))
	mux.HandleFunc("POST /v1/nodes", c.need(c.postNode))
	mux.HandleFunc("GET /v1/nodes/{id}/bootstrap", c.need(c.getBootstrap))
	mux.HandleFunc("POST /v1/nodes/{id}/rotate", c.need(c.postRotate))
	mux.HandleFunc("POST /v1/nodes/{id}/hello", c.need(c.postHello))
	mux.HandleFunc("POST /v1/nodes/{id}/disconnect", c.need(c.postDisconnect))
	mux.HandleFunc("POST /v1/nodes/{id}/revoke", c.need(c.postRevoke))
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
	mux.HandleFunc("PUT /v1/nodes/{id}/mappings", c.need(c.putMaps))
	mux.HandleFunc("POST /v1/knock/{id}", c.need(c.postKnockRaw))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if origin := r.Header.Get("Origin"); origin != "" {
				if !originOK(origin, r.Host) {
					writeErr(w, http.StatusForbidden, "跨站请求已拒绝")
					return
				}
			}
		}
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

func originOK(origin, host string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	return strings.EqualFold(u.Host, host)
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
	r.Body = http.MaxBytesReader(nil, r.Body, jsonBodyLimit)
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(v); err != nil {
		return err
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return fmt.Errorf("trailing json")
		}
		return err
	}
	return nil
}

func jsonBody(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := readJSON(r, v); err != nil {
		var mb *http.MaxBytesError
		if errors.As(err, &mb) {
			writeErr(w, http.StatusRequestEntityTooLarge, "请求过大")
			return false
		}
		writeErr(w, 400, "bad json")
		return false
	}
	return true
}

func persistFail(w http.ResponseWriter) {
	writeErr(w, http.StatusInternalServerError, "状态未能落盘")
}

func (c *Console) getHealth(w http.ResponseWriter, _ *http.Request) {
	ph := c.Gate.PlaneHealth()
	persistOK := true
	if c.Persist != "" {
		if st, err := os.Stat(c.Persist); err != nil {
			persistOK = os.IsNotExist(err)
		} else if st.Size() == 0 {
			persistOK = false
		}
	}
	ok := ph.Control && persistOK
	if ph.UDP == "required" && !ph.UPlane {
		ok = false
	}
	status := http.StatusOK
	if !ok {
		status = http.StatusServiceUnavailable
	}
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(struct {
		OK      bool   `json:"ok"`
		Control bool   `json:"control"`
		UPlane  bool   `json:"uplane"`
		Persist bool   `json:"persist"`
		UDP     string `json:"udp"`
	}{OK: ok, Control: ph.Control, UPlane: ph.UPlane, Persist: persistOK, UDP: ph.UDP})
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
	if !jsonBody(w, r, &b) {
		return
	}
	if err := c.setup(b.Password); err != nil {
		if errors.Is(err, errPersist) {
			persistFail(w)
			return
		}
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
	if !jsonBody(w, r, &b) {
		return
	}
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	if err := c.login(b.Password, ip); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	c.setCookie(w, r)
	writeJSON(w, map[string]any{"ok": true})
}

func (c *Console) postLogout(w http.ResponseWriter, r *http.Request) {
	sid := readOwnerCookie(r)
	c.mu.Lock()
	h := ""
	if sid != "" {
		h = gate.TicketHash(sid)
	}
	prev := c.sessions[h]
	c.dropSessionLocked(sid)
	if err := c.save(); err != nil {
		if h != "" && prev != nil {
			c.sessions[h] = prev
		}
		c.mu.Unlock()
		persistFail(w)
		return
	}
	c.mu.Unlock()
	clearOwnerCookie(w)
	writeJSON(w, map[string]any{"ok": true})
}

func (c *Console) postLogoutAll(w http.ResponseWriter, _ *http.Request) {
	c.mu.Lock()
	prev := c.sessions
	c.dropAllSessionsLocked()
	if err := c.save(); err != nil {
		c.sessions = prev
		c.mu.Unlock()
		persistFail(w)
		return
	}
	c.mu.Unlock()
	clearOwnerCookie(w)
	writeJSON(w, map[string]any{"ok": true})
}

func (c *Console) postPassword(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Current string `json:"current"`
		New     string `json:"new"`
	}
	if !jsonBody(w, r, &b) {
		return
	}
	c.mu.Lock()
	stored := c.ownerHash
	c.mu.Unlock()
	if stored == "" || !checkPassword(b.Current, stored) {
		writeErr(w, 400, "口令不对")
		return
	}
	if len(b.New) < 8 || len(b.New) > 128 {
		writeErr(w, 400, "口令至少 8 位")
		return
	}
	h, err := hashPassword(b.New)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	c.mu.Lock()
	prevHash, prevEpoch := c.ownerHash, c.ownerEpoch
	prevSess := c.sessions
	c.ownerHash = h
	c.ownerEpoch++
	c.dropAllSessionsLocked()
	sid := c.issueSessionLocked()
	if err := c.save(); err != nil {
		c.ownerHash, c.ownerEpoch, c.sessions = prevHash, prevEpoch, prevSess
		c.mu.Unlock()
		persistFail(w)
		return
	}
	c.mu.Unlock()
	c.writeOwnerCookie(w, r, sid)
	writeJSON(w, map[string]any{"ok": true})
}

func readOwnerCookie(r *http.Request) string {
	ck, _ := r.Cookie("umbra_owner")
	if ck == nil {
		return ""
	}
	return ck.Value
}

func clearOwnerCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: "umbra_owner", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode})
}

func (c *Console) writeOwnerCookie(w http.ResponseWriter, r *http.Request, sid string) {
	http.SetCookie(w, &http.Cookie{
		Name: "umbra_owner", Value: sid, Path: "/", HttpOnly: true,
		SameSite: http.SameSiteLaxMode, MaxAge: int(sessionTTL.Seconds()), Secure: c.cookieSecure(r),
	})
}

func (c *Console) setCookie(w http.ResponseWriter, r *http.Request) {
	c.mu.Lock()
	sid := c.issueSessionLocked()
	_ = c.save()
	c.mu.Unlock()
	c.writeOwnerCookie(w, r, sid)
}

func (c *Console) live() map[string]gateNode {
	st := c.Gate.Status()
	out := map[string]gateNode{}
	for _, a := range st.Nodes {
		out[a.ID] = gateNode{Online: a.Online, Addr: a.Addr, OS: a.OS, Arch: a.Arch, Ver: a.Ver}
	}
	return out
}

type gateNode struct {
	Online              bool
	Addr, OS, Arch, Ver string
}

func (c *Console) getNodes(w http.ResponseWriter, _ *http.Request) {
	live := c.live()
	stats := c.Gate.MappingStats()
	c.mu.Lock()
	defer c.mu.Unlock()
	out := []map[string]any{}
	for _, a := range c.nodes {
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
			if m.NodeID == a.ID {
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
		exp := ""
		if !a.TokenUntil.IsZero() {
			exp = a.TokenUntil.UTC().Format(time.RFC3339)
		}
		out = append(out, map[string]any{
			"id": a.ID, "name": a.Name, "comment": a.Comment, "status": st,
			"addr": addr, "version": ver, "os": os, "arch": arch,
			"lastSeen": last, "enabled": a.Enabled && a.Status != "revoked",
			"createdAt":      a.Created.UTC().Format(time.RFC3339),
			"tokenExpiresAt": exp,
			"mappingCount":   n, "bytesIn": in, "bytesOut": outB,
		})
	}
	writeJSON(w, out)
}

func (c *Console) postNode(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Name, Comment, OS, Arch string
	}
	if !jsonBody(w, r, &b) {
		return
	}
	if strings.TrimSpace(b.Name) == "" {
		writeErr(w, 400, "需要名称")
		return
	}
	id := newID("nde")
	plain, hash := newNodeToken()
	until := time.Now().Add(gate.TokenTTL)
	c.mu.Lock()
	rec := &nodeRec{
		ID: id, Name: strings.TrimSpace(b.Name), Comment: strings.TrimSpace(b.Comment),
		OS: b.OS, Arch: b.Arch, TokenHash: hash, TokenUntil: until, Status: "offline", Enabled: true, Created: time.Now(),
		revealed: plain,
	}
	c.nodes[id] = rec
	c.installToken(hash, id, until)
	c.logAudit("node.create", id, rec.Name+" "+rec.OS+"/"+rec.Arch)
	if err := c.save(); err != nil {
		delete(c.nodes, id)
		c.Gate.Revoke(id)
		c.mu.Unlock()
		persistFail(w)
		return
	}
	c.mu.Unlock()
	writeJSON(w, map[string]any{
		"id": id, "token": plain, "os": rec.OS, "arch": rec.Arch,
		"expiresAt": until.UTC().Format(time.RFC3339),
	})
}

func (c *Console) getBootstrap(w http.ResponseWriter, r *http.Request) {
	writeErr(w, http.StatusGone, "凭证只在签发或轮换时显示，请轮换后重新配置节点")
}

func (c *Console) postRotate(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	c.mu.Lock()
	a := c.nodes[id]
	if a == nil || a.Status == "revoked" {
		c.mu.Unlock()
		writeErr(w, 404, "节点不存在")
		return
	}
	plain, hash := newNodeToken()
	old := a.TokenHash
	oldUntil := a.TokenUntil
	oldPrev, oldPrevUntil := a.PrevHash, a.PrevUntil
	grace := gate.TokenGrace
	until := time.Now().Add(gate.TokenTTL)
	a.TokenHash = hash
	a.TokenUntil = until
	a.Token = ""
	a.revealed = plain
	graceSec := 0
	if g, ok := gate.TokenGraceUntil(oldUntil, grace); ok && old != "" && old != hash {
		a.PrevHash, a.PrevUntil = old, g
		graceSec = int(time.Until(g).Seconds())
		if graceSec < 0 {
			graceSec = 0
		}
	} else {
		a.PrevHash, a.PrevUntil = "", time.Time{}
		c.revokeHash(old)
		c.revokeHash(oldPrev)
	}
	c.logAudit("node.rotate", id, "")
	if err := c.save(); err != nil {
		a.TokenHash, a.TokenUntil, a.PrevHash, a.PrevUntil, a.revealed = old, oldUntil, oldPrev, oldPrevUntil, ""
		c.mu.Unlock()
		persistFail(w)
		return
	}
	c.mu.Unlock()
	c.Gate.RotateTokenUntil(id, old, hash, until, grace)
	c.installToken(hash, id, until)
	writeJSON(w, map[string]any{
		"token": plain, "graceSec": graceSec,
		"expiresAt": until.UTC().Format(time.RFC3339),
	})
}

func (c *Console) postHello(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	c.mu.Lock()
	a := c.nodes[id]
	tok := ""
	if a != nil {
		tok = a.revealed
	}
	c.mu.Unlock()
	if a == nil {
		writeErr(w, 404, "节点不存在")
		return
	}
	if tok != "" {
		c.spawnNode(tok)
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
		if m.NodeID == id && m.Spec.Enabled {
			n++
		}
	}
	if a := c.nodes[id]; a != nil {
		now := time.Now()
		a.LastSeen = &now
	}
	c.logAudit("node.hello", id, "HelloOk")
	if err := c.save(); err != nil {
		c.mu.Unlock()
		persistFail(w)
		return
	}
	c.mu.Unlock()
	writeJSON(w, map[string]any{"ok": true, "pushed": n})
}

func (c *Console) postDisconnect(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	c.mu.Lock()
	c.logAudit("node.disconnect", id, "")
	if err := c.save(); err != nil {
		c.mu.Unlock()
		persistFail(w)
		return
	}
	c.mu.Unlock()
	c.Gate.Disconnect(id)
	w.WriteHeader(204)
}

func (c *Console) postRevoke(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	c.mu.Lock()
	a := c.nodes[id]
	if a == nil {
		c.mu.Unlock()
		writeErr(w, 404, "节点不存在")
		return
	}
	prevStatus, prevEnabled := a.Status, a.Enabled
	prevHash, prevPrev, prevUntil, prevRevealed := a.TokenHash, a.PrevHash, a.PrevUntil, a.revealed
	prevTokUntil := a.TokenUntil
	c.revokeHash(a.TokenHash)
	c.revokeHash(a.PrevHash)
	a.Status = "revoked"
	a.Enabled = false
	a.Token = ""
	a.TokenHash = ""
	a.TokenUntil = time.Time{}
	a.PrevHash = ""
	a.PrevUntil = time.Time{}
	a.revealed = ""
	c.logAudit("node.revoke", id, "")
	if err := c.save(); err != nil {
		a.Status, a.Enabled = prevStatus, prevEnabled
		a.TokenHash, a.TokenUntil, a.PrevHash, a.PrevUntil, a.revealed = prevHash, prevTokUntil, prevPrev, prevUntil, prevRevealed
		c.mu.Unlock()
		persistFail(w)
		return
	}
	c.mu.Unlock()
	c.Gate.Revoke(id)
	w.WriteHeader(204)
}

func (c *Console) getMappings(w http.ResponseWriter, _ *http.Request) {
	live := c.live()
	stats := c.Gate.MappingStats()
	c.mu.Lock()
	defer c.mu.Unlock()
	out := []map[string]any{}
	for _, m := range c.maps {
		a := c.nodes[m.NodeID]
		name, ast := "", "offline"
		if a != nil {
			name, ast = a.Name, a.Status
			if g, ok := live[a.ID]; ok && g.Online && a.Status != "revoked" {
				ast = "online"
			}
		}
		in, outB, active := m.BytesIn, m.BytesOut, 0
		listen, push, listenErr := m.ListenState, m.PushState, m.ListenError
		if !m.Spec.Enabled {
			listen, push, listenErr = "disabled", "acked", ""
		} else if s, ok := stats[m.Spec.ID]; ok {
			in, outB, active = s.In, s.Out, s.Active
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
		grant := ""
		last := ""
		if m.LastProbe != nil {
			last = m.LastProbe.UTC().Format(time.RFC3339)
		}
		out = append(out, map[string]any{
			"id": m.Spec.ID, "nodeId": m.NodeID, "nodeName": name, "nodeStatus": ast,
			"name": m.Spec.Name, "proto": m.Spec.Proto, "mode": m.Spec.Mode,
			"entryPort": port, "localHost": m.Spec.LocalHost, "localPort": m.Spec.LocalPort,
			"enabled": m.Spec.Enabled, "listenState": listen, "listenError": nilIfEmpty(listenErr),
			"pushState": push, "bytesIn": in, "bytesOut": outB, "activeConns": active,
			"lastProbeAt": last, "lastProbePreview": m.LastPreview, "grantUntil": grant,
			"maxConns": m.Spec.MaxConns, "rateKbps": m.Spec.RateKbps, "allowCidrs": m.Spec.AllowCidrs,
			"udpVia":    stats[m.Spec.ID].UDPVia,
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

func validateMapping(proto, mode string, entry *int, localHost string, localPort int) error {
	if proto != "tcp" && proto != "udp" {
		return fmt.Errorf("协议只能是 tcp 或 udp")
	}
	if mode != "visitor" && mode != "spa" && mode != "public" {
		return fmt.Errorf("模式无效")
	}
	if strings.TrimSpace(localHost) == "" {
		return fmt.Errorf("需要目标地址")
	}
	if localPort < 1 || localPort > 65535 {
		return fmt.Errorf("目标端口无效")
	}
	if mode == "visitor" {
		if entry != nil {
			return fmt.Errorf("访客模式不能占用入口端口")
		}
		return nil
	}
	if entry == nil {
		return fmt.Errorf("公开或暗端口模式必须指定入口端口")
	}
	if *entry < 1 || *entry > 65535 {
		return fmt.Errorf("入口端口无效")
	}
	return nil
}

func (c *Console) portTaken(selfID string, spec wire.Mapping) error {
	if spec.Mode == "visitor" || spec.EntryPort == nil {
		return nil
	}
	for id, m := range c.maps {
		if id == selfID || !m.Spec.Enabled || m.Spec.Mode == "visitor" || m.Spec.EntryPort == nil {
			continue
		}
		if m.Spec.Proto == spec.Proto && *m.Spec.EntryPort == *spec.EntryPort {
			return fmt.Errorf("端口 %s/%d 已被映射占用", spec.Proto, *spec.EntryPort)
		}
	}
	return nil
}

func (c *Console) checkSpec(selfID string, spec wire.Mapping) error {
	if err := validateMapping(spec.Proto, spec.Mode, spec.EntryPort, spec.LocalHost, spec.LocalPort); err != nil {
		return err
	}
	if spec.Enabled {
		return c.portTaken(selfID, spec)
	}
	return nil
}

func (c *Console) checkSpecs(batch map[string]wire.Mapping) error {
	seen := map[string]string{}
	for id, spec := range batch {
		if err := validateMapping(spec.Proto, spec.Mode, spec.EntryPort, spec.LocalHost, spec.LocalPort); err != nil {
			return err
		}
		if !spec.Enabled || spec.Mode == "visitor" || spec.EntryPort == nil {
			continue
		}
		key := fmt.Sprintf("%s/%d", spec.Proto, *spec.EntryPort)
		if other, ok := seen[key]; ok && other != id {
			return fmt.Errorf("端口 %s/%d 已被映射占用", spec.Proto, *spec.EntryPort)
		}
		seen[key] = id
	}
	for id, spec := range batch {
		if spec.Enabled {
			if err := c.portTaken(id, spec); err != nil {
				return err
			}
		}
	}
	return nil
}

func (c *Console) postMapping(w http.ResponseWriter, r *http.Request) {
	var b struct {
		NodeID     string `json:"nodeId"`
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
	if !jsonBody(w, r, &b) {
		return
	}
	if err := validateMapping(b.Proto, b.Mode, b.EntryPort, b.LocalHost, b.LocalPort); err != nil {
		writeErr(w, 400, err.Error())
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
		Generation: 1,
	}
	now := time.Now()
	c.mu.Lock()
	if c.nodes[b.NodeID] == nil {
		c.mu.Unlock()
		writeErr(w, 404, "节点不存在")
		return
	}
	if err := c.portTaken(id, spec); err != nil {
		c.mu.Unlock()
		writeErr(w, 400, err.Error())
		return
	}
	c.maps[id] = &mapRec{Spec: spec, NodeID: b.NodeID, ListenState: "pending", PushState: "pending_offline", Created: now, Updated: now}
	c.logAudit("mapping.create", id, spec.Name)
	if err := c.save(); err != nil {
		delete(c.maps, id)
		c.mu.Unlock()
		persistFail(w)
		return
	}
	c.mu.Unlock()
	c.push(b.NodeID)
	writeJSON(w, map[string]any{"id": id, "nodeId": b.NodeID, "name": spec.Name})
}

func (c *Console) postEnabled(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Enabled bool `json:"enabled"`
	}
	if !jsonBody(w, r, &b) {
		return
	}
	id := r.PathValue("id")
	c.mu.Lock()
	m := c.maps[id]
	if m == nil {
		c.mu.Unlock()
		writeErr(w, 404, "映射不存在")
		return
	}
	if b.Enabled {
		spec := m.Spec
		spec.Enabled = true
		if err := c.checkSpec(id, spec); err != nil {
			c.mu.Unlock()
			writeErr(w, 400, err.Error())
			return
		}
	}
	prev := m.Spec.Enabled
	m.Spec.Enabled = b.Enabled
	bumpGeneration(&m.Spec)
	m.Updated = time.Now()
	aid := m.NodeID
	if err := c.save(); err != nil {
		m.Spec.Enabled = prev
		c.mu.Unlock()
		persistFail(w)
		return
	}
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
	aid := m.NodeID
	delete(c.maps, id)
	for tid, t := range c.tickets {
		if t.MappingID == id {
			delete(c.tickets, tid)
		}
	}
	c.Gate.DeleteTicketsFor(id)
	c.logAudit("mapping.delete", id, "")
	if err := c.save(); err != nil {
		c.maps[id] = m
		c.mu.Unlock()
		persistFail(w)
		return
	}
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
	payload := []byte("umbra-probe " + id + "\n")
	if m.Spec.Mode == "spa" {
		c.Gate.Knock(id, 60*time.Second)
		time.Sleep(50 * time.Millisecond)
	}
	var preview string
	var inN, outN int
	if m.Spec.Mode == "visitor" || visit || m.Spec.EntryPort == nil {
		reply, err := c.Gate.Probe(id, payload, 2*time.Second)
		if err != nil {
			writeErr(w, 400, err.Error())
			return
		}
		preview = string(reply)
		inN, outN = len(reply), len(payload)
	} else {
		addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(*m.Spec.EntryPort))
		network := "tcp"
		if m.Spec.Proto == "udp" {
			network = "udp"
		}
		conn, err := net.DialTimeout(network, addr, 2*time.Second)
		if err != nil {
			writeErr(w, 400, err.Error())
			return
		}
		defer conn.Close()
		_, _ = conn.Write(payload)
		_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		buf := make([]byte, 256)
		n, _ := conn.Read(buf)
		preview = string(buf[:n])
		inN, outN = n, len(payload)
	}
	now := time.Now()
	c.mu.Lock()
	m.LastProbe = &now
	m.LastPreview = preview
	c.logAudit("mapping.probe", id, "")
	c.mu.Unlock()
	writeJSON(w, map[string]any{"bytesIn": inN, "bytesOut": outN, "preview": preview})
}

func (c *Console) postVisitor(w http.ResponseWriter, r *http.Request) {
	mapID := r.PathValue("id")
	var b struct {
		Label string `json:"label"`
	}
	if !jsonBody(w, r, &b) {
		return
	}
	c.mu.Lock()
	m := c.maps[mapID]
	if m == nil {
		c.mu.Unlock()
		writeErr(w, 404, "映射不存在")
		return
	}
	if m.Spec.Mode != "visitor" {
		c.mu.Unlock()
		writeErr(w, 400, "只有访客模式能签发票据")
		return
	}
	id := newID("vis")
	ticket := "umbra_vis_" + newID("k")[2:]
	exp := time.Now().Add(24 * time.Hour)
	rec := &ticketRec{
		ID: id, MappingID: mapID, Hash: gate.TicketHash(ticket),
		Label: strings.TrimSpace(b.Label), Expires: exp, Created: time.Now(),
	}
	c.tickets[id] = rec
	c.Gate.SetTicket(rec.Hash, mapID, exp)
	c.logAudit("visitor.issue", mapID, rec.ID)
	if err := c.save(); err != nil {
		delete(c.tickets, id)
		c.Gate.DeleteTicket(rec.Hash)
		c.mu.Unlock()
		persistFail(w)
		return
	}
	listen := c.Listen
	ca := c.CAFile
	proto := m.Spec.Proto
	c.mu.Unlock()
	local := "127.0.0.1:2222"
	cmd := "umbra-visit --server " + listen + " --ticket " + ticket + " --local " + local
	if ca != "" {
		cmd += " --tls-ca " + ca
	}
	if proto == "udp" {
		cmd += "  # UDP"
	}
	writeJSON(w, map[string]any{
		"id": id, "ticket": ticket, "visitCmd": cmd,
		"expiresAt": exp.UTC().Format(time.RFC3339),
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
	q := r.URL.Query()
	mappingID := q.Get("mappingId")
	nodeID := q.Get("nodeId")
	since := time.Now()
	switch q.Get("range") {
	case "1h":
		since = since.Add(-time.Hour)
	case "7d":
		since = since.Add(-7 * 24 * time.Hour)
	default:
		since = since.Add(-24 * time.Hour)
	}
	stats := c.Gate.MappingStats()
	c.mu.Lock()
	defer c.mu.Unlock()
	allow := map[string]bool{}
	for id, m := range c.maps {
		if mappingID != "" && id != mappingID {
			continue
		}
		if nodeID != "" && m.NodeID != nodeID {
			continue
		}
		allow[id] = true
	}
	var liveIn, liveOut int64
	for id, s := range stats {
		if mappingID == "" && nodeID == "" || allow[id] {
			liveIn += s.In
			liveOut += s.Out
		}
	}
	series := []map[string]any{}
	var prevIn, prevOut int64
	var prevTs time.Time
	var peakIn, peakOut float64
	first := true
	for _, s := range c.samples {
		if s.Ts.Before(since) {
			continue
		}
		in, out := s.In, s.Out
		if mappingID != "" || nodeID != "" {
			in, out = 0, 0
			for id, pair := range s.By {
				if allow[id] {
					in += pair[0]
					out += pair[1]
				}
			}
		}
		series = append(series, map[string]any{
			"ts": s.Ts.UTC().Format(time.RFC3339), "bytesIn": in, "bytesOut": out,
		})
		if !first {
			dt := s.Ts.Sub(prevTs).Seconds()
			if dt > 0 {
				if d := in - prevIn; d > 0 {
					if bps := float64(d) / dt; bps > peakIn {
						peakIn = bps
					}
				}
				if d := out - prevOut; d > 0 {
					if bps := float64(d) / dt; bps > peakOut {
						peakOut = bps
					}
				}
			}
		}
		first = false
		prevIn, prevOut, prevTs = in, out, s.Ts
	}
	writeJSON(w, map[string]any{
		"bytesIn": liveIn, "bytesOut": liveOut,
		"peakBpsIn": int64(peakIn), "peakBpsOut": int64(peakOut),
		"series": series,
	})
}

func (c *Console) getOverview(w http.ResponseWriter, _ *http.Request) {
	live := c.live()
	stats := c.Gate.MappingStats()
	c.mu.Lock()
	defer c.mu.Unlock()
	online, total := 0, len(c.nodes)
	for _, a := range c.nodes {
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
	var liveIn, liveOut int64
	for _, s := range stats {
		liveIn += s.In
		liveOut += s.Out
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
	var bpsIn, bpsOut float64
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
	recent := []map[string]any{}
	for i := len(c.audit) - 1; i >= 0 && len(recent) < 8; i-- {
		a := c.audit[i]
		recent = append(recent, map[string]any{
			"id": a.ID, "ts": a.Ts.UTC().Format(time.RFC3339),
			"actor": a.Actor, "action": a.Action, "target": a.Target, "detail": a.Detail,
		})
	}
	writeJSON(w, map[string]any{
		"nodesOnline": online, "nodesTotal": total,
		"mappingsActive": active, "mappingsTotal": maps,
		"bytesInToday": dayIn, "bytesOutToday": dayOut,
		"bpsIn": int64(bpsIn), "bpsOut": int64(bpsOut),
		"recentAudit": recent,
	})
}

func (c *Console) getStatus(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, c.Gate.Status())
}

func (c *Console) putToken(w http.ResponseWriter, r *http.Request) {
	var b struct {
		NodeID string `json:"node_id"`
	}
	if !jsonBody(w, r, &b) {
		return
	}
	if strings.TrimSpace(b.NodeID) == "" {
		writeErr(w, 400, "需要 node_id")
		return
	}
	plain := r.PathValue("token")
	if plain == "" {
		writeErr(w, 400, "需要凭证")
		return
	}
	hash := gate.TicketHash(plain)
	until := time.Now().Add(gate.TokenTTL)
	c.mu.Lock()
	rec := c.nodes[b.NodeID]
	if rec == nil {
		rec = &nodeRec{ID: b.NodeID, Name: b.NodeID, Status: "offline", Enabled: true, Created: time.Now()}
		c.nodes[b.NodeID] = rec
	}
	if rec.Status == "revoked" {
		c.mu.Unlock()
		writeErr(w, 404, "节点不存在")
		return
	}
	old, oldUntil, oldPrev, oldPrevUntil := rec.TokenHash, rec.TokenUntil, rec.PrevHash, rec.PrevUntil
	rec.TokenHash, rec.TokenUntil = hash, until
	rec.PrevHash, rec.PrevUntil, rec.Token = "", time.Time{}, ""
	if err := c.save(); err != nil {
		rec.TokenHash, rec.TokenUntil, rec.PrevHash, rec.PrevUntil = old, oldUntil, oldPrev, oldPrevUntil
		c.mu.Unlock()
		persistFail(w)
		return
	}
	if old != "" && old != hash {
		c.revokeHash(old)
	}
	c.revokeHash(oldPrev)
	_ = c.saveTomb()
	c.installToken(hash, rec.ID, until)
	c.mu.Unlock()
	w.WriteHeader(204)
}

func (c *Console) putMaps(w http.ResponseWriter, r *http.Request) {
	var maps []wire.Mapping
	if !jsonBody(w, r, &maps) {
		return
	}
	id := r.PathValue("id")
	c.mu.Lock()
	batch := map[string]wire.Mapping{}
	for _, spec := range maps {
		if spec.ID == "" {
			c.mu.Unlock()
			writeErr(w, 400, "映射缺少 id")
			return
		}
		batch[spec.ID] = spec
	}
	if err := c.checkSpecs(batch); err != nil {
		c.mu.Unlock()
		writeErr(w, 400, err.Error())
		return
	}
	now := time.Now()
	prev := map[string]*mapRec{}
	created := []string{}
	for _, spec := range maps {
		if existing := c.maps[spec.ID]; existing != nil {
			cp := *existing
			prev[spec.ID] = &cp
			oldGen := existing.Spec.Generation
			existing.Spec = spec
			existing.Spec.Generation = oldGen
			bumpGeneration(&existing.Spec)
			existing.NodeID = id
			existing.Updated = now
		} else {
			if spec.Generation <= 0 {
				spec.Generation = 1
			}
			c.maps[spec.ID] = &mapRec{Spec: spec, NodeID: id, Created: now, Updated: now}
			created = append(created, spec.ID)
		}
	}
	if err := c.save(); err != nil {
		for _, mid := range created {
			delete(c.maps, mid)
		}
		for mid, rec := range prev {
			c.maps[mid] = rec
		}
		c.mu.Unlock()
		persistFail(w)
		return
	}
	c.mu.Unlock()
	c.Gate.PutMappings(id, maps)
	w.WriteHeader(204)
}

func (c *Console) postDemo(w http.ResponseWriter, _ *http.Request) {
	c.mu.Lock()
	var demo *nodeRec
	for _, a := range c.nodes {
		if a.Name == "演示节点" && a.Status != "revoked" {
			demo = a
			break
		}
	}
	if demo == nil {
		id := newID("nde")
		plain, hash := newNodeToken()
		until := time.Now().Add(gate.TokenTTL)
		demo = &nodeRec{ID: id, Name: "演示节点", Comment: "本机演示", OS: "linux", Arch: "amd64", TokenHash: hash, TokenUntil: until, Status: "offline", Enabled: true, Created: time.Now(), revealed: plain}
		c.nodes[id] = demo
		c.installToken(hash, id, until)
		_ = c.save()
	}
	if demo.revealed == "" {
		plain, hash := newNodeToken()
		old := demo.TokenHash
		oldUntil := demo.TokenUntil
		until := time.Now().Add(gate.TokenTTL)
		demo.TokenHash = hash
		demo.TokenUntil = until
		if g, ok := gate.TokenGraceUntil(oldUntil, gate.TokenGrace); ok && old != "" && old != hash {
			demo.PrevHash, demo.PrevUntil = old, g
		} else {
			demo.PrevHash, demo.PrevUntil = "", time.Time{}
			c.revokeHash(old)
		}
		demo.revealed = plain
		_ = c.save()
		c.mu.Unlock()
		c.Gate.RotateTokenUntil(demo.ID, old, hash, until, gate.TokenGrace)
		c.installToken(hash, demo.ID, until)
		c.mu.Lock()
	}
	tok := demo.revealed
	aid := demo.ID
	c.mu.Unlock()
	c.spawnNode(tok)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if g, ok := c.live()[aid]; ok && g.Online {
			break
		}
		time.Sleep(80 * time.Millisecond)
	}
	c.push(aid)
	writeJSON(w, map[string]any{
		"nodeId": aid, "mappingId": "", "bytesIn": 0, "bytesOut": 0,
		"preview": "", "dropped": true, "udpBytesIn": 0, "udpBytesOut": 0,
	})
}

func (c *Console) push(nodeID string) {
	c.mu.Lock()
	var maps []wire.Mapping
	for _, m := range c.maps {
		if m.NodeID == nodeID {
			maps = append(maps, m.Spec)
		}
	}
	c.mu.Unlock()
	c.Gate.PutMappings(nodeID, maps)
}
