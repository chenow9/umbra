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
	"umbra/internal/policy"
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
	mux.HandleFunc("PATCH /v1/nodes/{id}", c.need(c.patchNode))
	mux.HandleFunc("POST /v1/nodes/{id}", c.need(c.patchNode))
	mux.HandleFunc("DELETE /v1/nodes/{id}", c.need(c.postDeleteNode))
	mux.HandleFunc("POST /v1/nodes/{id}/delete", c.need(c.postDeleteNode))
	mux.HandleFunc("GET /v1/nodes/{id}/bootstrap", c.need(c.getBootstrap))
	mux.HandleFunc("POST /v1/nodes/{id}/rotate", c.need(c.postRotate))
	mux.HandleFunc("POST /v1/nodes/{id}/hello", c.need(c.postHello))
	mux.HandleFunc("POST /v1/nodes/{id}/disconnect", c.need(c.postDisconnect))
	mux.HandleFunc("POST /v1/nodes/{id}/revoke", c.need(c.postRevoke))
	mux.HandleFunc("GET /v1/mappings", c.need(c.getMappings))
	mux.HandleFunc("POST /v1/mappings", c.need(c.postMapping))
	mux.HandleFunc("PATCH /v1/mappings/{id}", c.need(c.patchMapping))
	mux.HandleFunc("POST /v1/mappings/{id}", c.need(c.patchMapping))
	mux.HandleFunc("DELETE /v1/mappings/{id}", c.need(c.postDeleteMap))
	mux.HandleFunc("POST /v1/mappings/{id}/enabled", c.need(c.postEnabled))
	mux.HandleFunc("POST /v1/mappings/{id}/delete", c.need(c.postDeleteMap))
	mux.HandleFunc("GET /v1/events", c.need(c.getEvents))
	mux.HandleFunc("POST /v1/mappings/{id}/knock", c.need(c.postKnock))
	mux.HandleFunc("POST /v1/mappings/{id}/probe", c.need(c.postProbe))
	mux.HandleFunc("POST /v1/mappings/{id}/visit", c.need(c.postVisit))
	mux.HandleFunc("POST /v1/mappings/{id}/visitor", c.need(c.postVisitor))
	mux.HandleFunc("GET /v1/ca", c.need(c.getCA))
	mux.HandleFunc("GET /v1/tickets", c.need(c.getTickets))
	mux.HandleFunc("DELETE /v1/tickets/{id}", c.need(c.deleteTicket))
	mux.HandleFunc("POST /v1/tickets/{id}/delete", c.need(c.deleteTicket))
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
		if r.URL.Path == "/agents" || strings.HasPrefix(r.URL.Path, "/agents/") {
			http.Redirect(w, r, "/nodes"+strings.TrimPrefix(r.URL.Path, "/agents"), http.StatusMovedPermanently)
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

func (c *Console) getCA(w http.ResponseWriter, _ *http.Request) {
	if c.CAFile == "" {
		writeErr(w, 404, "没有 CA 文件")
		return
	}
	b, err := os.ReadFile(c.CAFile)
	if err != nil {
		writeErr(w, 404, "没有 CA 文件")
		return
	}
	w.Header().Set("Content-Type", "application/x-pem-file")
	w.Header().Set("Content-Disposition", "attachment; filename=\"ca.crt\"")
	_, _ = w.Write(b)
}

func (c *Console) getTickets(w http.ResponseWriter, r *http.Request) {
	want := r.URL.Query().Get("mappingId")
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]map[string]any, 0, len(c.tickets))
	for _, t := range c.tickets {
		if want != "" && t.MappingID != want {
			continue
		}
		name := ""
		if m := c.maps[t.MappingID]; m != nil {
			name = m.Spec.Name
		}
		out = append(out, map[string]any{
			"id": t.ID, "mappingId": t.MappingID, "mappingName": name, "label": t.Label,
			"expiresAt": rfc3339(t.Expires), "createdAt": rfc3339(t.Created),
			"expired": now.After(t.Expires),
		})
	}
	writeJSON(w, out)
}

func (c *Console) deleteTicket(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	c.mu.Lock()
	t := c.tickets[id]
	if t == nil {
		c.mu.Unlock()
		writeErr(w, 404, "票据不存在")
		return
	}
	delete(c.tickets, id)
	c.Gate.DeleteTicket(t.Hash)
	c.logAudit("visitor.revoke", t.MappingID, t.ID)
	if err := c.save(); err != nil {
		c.tickets[id] = t
		c.Gate.SetTicket(t.Hash, t.MappingID, t.Expires)
		c.mu.Unlock()
		persistFail(w)
		return
	}
	c.mu.Unlock()
	writeJSON(w, map[string]any{"ok": true})
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
	st := c.Gate.Status()
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(struct {
		OK                      bool   `json:"ok"`
		Control                 bool   `json:"control"`
		UPlane                  bool   `json:"uplane"`
		Persist                 bool   `json:"persist"`
		UDP                     string `json:"udp"`
		Active                  int    `json:"active"`
		UDPActive               int    `json:"udpActive"`
		UDPDropMaxConns         int64  `json:"udpDropMaxConns"`
		UDPDropPerIP            int64  `json:"udpDropPerIP"`
		UDPDropRate             int64  `json:"udpDropRate"`
		UDPIngressPackets       int64  `json:"udpIngressPackets"`
		UDPIngressBytes         int64  `json:"udpIngressBytes"`
		UDPToNodePackets        int64  `json:"udpToNodePackets"`
		UDPToNodeBytes          int64  `json:"udpToNodeBytes"`
		UDPFromNodePackets      int64  `json:"udpFromNodePackets"`
		UDPFromNodeBytes        int64  `json:"udpFromNodeBytes"`
		UDPToClientPackets      int64  `json:"udpToClientPackets"`
		UDPToClientBytes        int64  `json:"udpToClientBytes"`
		UDPDropACL              int64  `json:"udpDropAcl"`
		UDPDropSPA              int64  `json:"udpDropSpa"`
		UDPDropTrafficLimit     int64  `json:"udpDropTrafficLimit"`
		UDPDropNoPath           int64  `json:"udpDropNoPath"`
		UDPDropEncode           int64  `json:"udpDropEncode"`
		UDPDropUPlaneWrite      int64  `json:"udpDropUplaneWrite"`
		UDPDropTunnelWrite      int64  `json:"udpDropTunnelWrite"`
		UDPDropUnknownFlow      int64  `json:"udpDropUnknownFlow"`
		UDPDropClientWrite      int64  `json:"udpDropClientWrite"`
		UDPMaxFlowsPerIP        int    `json:"udpMaxFlowsPerIP"`
		UDPNewFlowsPerSec       int    `json:"udpNewFlowsPerSec"`
		UDPNewFlowsPerMap       int    `json:"udpNewFlowsPerMap"`
		UDPUPlaneRxPackets      int64  `json:"udpUplaneRxPackets"`
		UDPUPlaneRxBytes        int64  `json:"udpUplaneRxBytes"`
		UDPUPlaneReadErrors     int64  `json:"udpUplaneReadErrors"`
		UDPUPlanePeekErrors     int64  `json:"udpUplanePeekErrors"`
		UDPUPlaneUnknownPeer    int64  `json:"udpUplaneUnknownPeer"`
		UDPUPlaneDecodeErrors   int64  `json:"udpUplaneDecodeErrors"`
		UDPUPlaneUnknownType    int64  `json:"udpUplaneUnknownType"`
		UDPUPlaneUnknownMapping int64  `json:"udpUplaneUnknownMapping"`
		UDPUPlaneTxPackets      int64  `json:"udpUplaneTxPackets"`
		UDPUPlaneTxBytes        int64  `json:"udpUplaneTxBytes"`
		UDPUPlaneNotReady       int64  `json:"udpUplaneNotReady"`
		UDPUPlaneEncodeErrors   int64  `json:"udpUplaneEncodeErrors"`
		UDPUPlaneWriteErrors    int64  `json:"udpUplaneWriteErrors"`
	}{
		OK: ok, Control: ph.Control, UPlane: ph.UPlane, Persist: persistOK, UDP: ph.UDP,
		Active: st.Active, UDPActive: st.UDPActive,
		UDPDropMaxConns: st.UDPDropMaxConns, UDPDropPerIP: st.UDPDropPerIP, UDPDropRate: st.UDPDropRate,
		UDPIngressPackets: st.UDPIngressPackets, UDPIngressBytes: st.UDPIngressBytes,
		UDPToNodePackets: st.UDPToNodePackets, UDPToNodeBytes: st.UDPToNodeBytes,
		UDPFromNodePackets: st.UDPFromNodePackets, UDPFromNodeBytes: st.UDPFromNodeBytes,
		UDPToClientPackets: st.UDPToClientPackets, UDPToClientBytes: st.UDPToClientBytes,
		UDPDropACL: st.UDPDropACL, UDPDropSPA: st.UDPDropSPA, UDPDropTrafficLimit: st.UDPDropTrafficLimit,
		UDPDropNoPath: st.UDPDropNoPath, UDPDropEncode: st.UDPDropEncode,
		UDPDropUPlaneWrite: st.UDPDropUPlaneWrite, UDPDropTunnelWrite: st.UDPDropTunnelWrite,
		UDPDropUnknownFlow: st.UDPDropUnknownFlow, UDPDropClientWrite: st.UDPDropClientWrite,
		UDPMaxFlowsPerIP: st.UDPMaxFlowsPerIP, UDPNewFlowsPerSec: st.UDPNewFlowsPerSec, UDPNewFlowsPerMap: st.UDPNewFlowsPerMap,
		UDPUPlaneRxPackets: st.UDPUPlaneRxPackets, UDPUPlaneRxBytes: st.UDPUPlaneRxBytes,
		UDPUPlaneReadErrors: st.UDPUPlaneReadErrors, UDPUPlanePeekErrors: st.UDPUPlanePeekErrors,
		UDPUPlaneUnknownPeer: st.UDPUPlaneUnknownPeer, UDPUPlaneDecodeErrors: st.UDPUPlaneDecodeErrors,
		UDPUPlaneUnknownType: st.UDPUPlaneUnknownType, UDPUPlaneUnknownMapping: st.UDPUPlaneUnknownMapping,
		UDPUPlaneTxPackets: st.UDPUPlaneTxPackets, UDPUPlaneTxBytes: st.UDPUPlaneTxBytes,
		UDPUPlaneNotReady: st.UDPUPlaneNotReady, UDPUPlaneEncodeErrors: st.UDPUPlaneEncodeErrors,
		UDPUPlaneWriteErrors: st.UDPUPlaneWriteErrors,
	})
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

func (c *Console) getNodes(w http.ResponseWriter, r *http.Request) {
	live := c.live()
	stats := c.Gate.MappingStats()
	page, size, paged := parsePage(r)
	q := r.URL.Query()
	c.mu.Lock()
	defer c.mu.Unlock()
	c.touchOnlineLocked(live, time.Now())
	c.absorbAllLocked(stats)
	views := filterNodeViews(c.nodeViews(live, stats), q.Get("q"), q.Get("status"), q.Get("os"))
	writeList(w, views, page, size, paged)
}

func (c *Console) postNode(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Name, Comment, OS, Arch string
		NeverExpire             bool `json:"neverExpire"`
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
	until := lifetimeUntil(b.NeverExpire)
	c.mu.Lock()
	rec := &nodeRec{
		ID: id, Name: strings.TrimSpace(b.Name), Comment: strings.TrimSpace(b.Comment),
		OS: b.OS, Arch: b.Arch, TokenHash: hash, TokenUntil: until, TokenNoExpiry: b.NeverExpire,
		Status: "offline", Enabled: true, Created: time.Now(),
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
	out := c.enrollFields(plain, rec.OS, rec.Arch)
	out["id"] = id
	out["token"] = plain
	out["os"] = rec.OS
	out["arch"] = rec.Arch
	out["expiresAt"] = rfc3339(until)
	out["neverExpire"] = b.NeverExpire
	writeJSON(w, out)
}

func (c *Console) getBootstrap(w http.ResponseWriter, r *http.Request) {
	writeErr(w, http.StatusGone, "凭证只在签发或轮换时显示，请轮换后重新配置节点")
}

func (c *Console) postRotate(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var b struct {
		NeverExpire *bool `json:"neverExpire"`
	}
	if err := readJSONOptional(r, &b); err != nil {
		writeErr(w, 400, "bad json")
		return
	}
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
	oldNoExpiry := a.TokenNoExpiry
	if b.NeverExpire != nil {
		a.TokenNoExpiry = *b.NeverExpire
	}
	grace := gate.TokenGrace
	until := lifetimeUntil(a.TokenNoExpiry)
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
		a.TokenNoExpiry = oldNoExpiry
		c.mu.Unlock()
		persistFail(w)
		return
	}
	noExpiry := a.TokenNoExpiry
	nodeOS, nodeArch := a.OS, a.Arch
	c.mu.Unlock()
	c.Gate.RotateTokenUntil(id, old, hash, until, grace)
	c.installToken(hash, id, until)
	out := c.enrollFields(plain, nodeOS, nodeArch)
	out["token"] = plain
	out["graceSec"] = graceSec
	out["expiresAt"] = rfc3339(until)
	out["neverExpire"] = noExpiry
	writeJSON(w, out)
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

func (c *Console) getMappings(w http.ResponseWriter, r *http.Request) {
	live := c.live()
	stats := c.Gate.MappingStats()
	page, size, paged := parsePage(r)
	q := r.URL.Query()
	c.mu.Lock()
	defer c.mu.Unlock()
	c.absorbAllLocked(stats)
	views := filterMappingViews(c.mappingViews(live, stats), q.Get("q"), q.Get("nodeId"), q.Get("proto"), q.Get("mode"), q.Get("reach"))
	writeList(w, views, page, size, paged)
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
			return fmt.Errorf("访问端不能占用入口端口")
		}
		return nil
	}
	if entry == nil {
		return fmt.Errorf("public 或 spa 模式必须指定入口端口")
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
		NodeID            string `json:"nodeId"`
		AgentID           string `json:"agentId"`
		Name              string `json:"name"`
		Proto             string `json:"proto"`
		Mode              string `json:"mode"`
		EntryPort         *int   `json:"entryPort"`
		LocalHost         string `json:"localHost"`
		LocalPort         int    `json:"localPort"`
		MaxConns          int    `json:"maxConns"`
		RateKbps          int    `json:"rateKbps"`
		AllowCidrs        string `json:"allowCidrs"`
		IdleTimeoutSec    *int   `json:"idleTimeoutSec"`
		SpaTTLSec         *int   `json:"spaTtlSec"`
		UdpIdleTimeoutSec *int   `json:"udpIdleTimeoutSec"`
	}
	if !jsonBody(w, r, &b) {
		return
	}
	if strings.TrimSpace(b.NodeID) == "" {
		b.NodeID = strings.TrimSpace(b.AgentID)
	}
	if strings.TrimSpace(b.Mode) == "" {
		b.Mode = "public"
	}
	if err := validateMapping(b.Proto, b.Mode, b.EntryPort, b.LocalHost, b.LocalPort); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	id := newID("map")
	max := policy.MaxConns(b.MaxConns)
	idle := 0
	if b.IdleTimeoutSec != nil {
		idle = *b.IdleTimeoutSec
		if idle < 0 {
			idle = 0
		}
	}
	spaTTL := policy.DefaultSPATimeoutSec
	if b.SpaTTLSec != nil {
		spaTTL = policy.ClampTimeoutSec(*b.SpaTTLSec, policy.DefaultSPATimeoutSec)
	}
	udpIdle := policy.DefaultUDPIdleSec
	if b.UdpIdleTimeoutSec != nil {
		udpIdle = policy.ClampTimeoutSec(*b.UdpIdleTimeoutSec, policy.DefaultUDPIdleSec)
	}
	spec := wire.Mapping{
		ID: id, Name: strings.TrimSpace(b.Name), Proto: b.Proto, Mode: b.Mode,
		EntryPort: b.EntryPort, LocalHost: strings.TrimSpace(b.LocalHost), LocalPort: b.LocalPort,
		Enabled: true, MaxConns: max, RateKbps: b.RateKbps, AllowCidrs: b.AllowCidrs, IdleTimeoutSec: idle,
		SpaTTLSec: spaTTL, UdpIdleTimeoutSec: udpIdle,
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
	var b struct {
		IP string `json:"ip"`
	}
	if err := readJSONOptional(r, &b); err != nil {
		var mb *http.MaxBytesError
		if errors.As(err, &mb) {
			writeErr(w, http.StatusRequestEntityTooLarge, "请求过大")
			return
		}
		writeErr(w, 400, "bad json")
		return
	}
	c.mu.Lock()
	m := c.maps[id]
	if m == nil {
		c.mu.Unlock()
		writeErr(w, 404, "映射不存在")
		return
	}
	if m.Spec.Mode != "spa" || !m.Spec.Enabled {
		c.mu.Unlock()
		writeErr(w, 400, "只有启用的 spa 映射可以敲门")
		return
	}
	ttlSec := policy.ClampTimeoutSec(m.Spec.SpaTTLSec, policy.DefaultSPATimeoutSec)
	c.mu.Unlock()
	ip := strings.TrimSpace(b.IP)
	if ip == "" {
		ip = c.requestIP(r)
	} else {
		ip = policy.NormalizeIP(ip)
		if net.ParseIP(ip) == nil {
			writeErr(w, 400, "来源 IP 无效")
			return
		}
	}
	until := c.Gate.Knock(id, ip, time.Duration(ttlSec)*time.Second)
	c.mu.Lock()
	c.logAudit("mapping.knock", id, fmt.Sprintf("SPA grant %ds %s", ttlSec, ip))
	c.mu.Unlock()
	writeJSON(w, map[string]any{
		"until": until.UTC().Format(time.RFC3339), "ip": ip, "ttlSec": ttlSec,
	})
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
		c.Gate.Knock(id, "127.0.0.1", policy.SPATimeout(m.Spec.SpaTTLSec))
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
		writeErr(w, 400, "只有访问端映射能签发")
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
	proto := m.Spec.Proto
	c.mu.Unlock()
	local := "127.0.0.1:2222"
	cmd := "umbra-visit --server " + listen + " --tls-ca /etc/umbra/ca.crt --ticket " + ticket + " --local " + local
	if proto == "udp" {
		cmd += "  # UDP"
	}
	writeJSON(w, map[string]any{
		"id": id, "ticket": ticket, "visitCmd": cmd,
		"expiresAt": exp.UTC().Format(time.RFC3339),
	})
}

func (c *Console) targetNameLocked(target string) string {
	if n := c.nodes[target]; n != nil {
		return n.Name
	}
	if m := c.maps[target]; m != nil {
		if n := c.nodes[m.NodeID]; n != nil {
			return m.Spec.Name + " · " + n.Name
		}
		return m.Spec.Name
	}
	return target
}

func (c *Console) getAudit(w http.ResponseWriter, r *http.Request) {
	page, size, paged := parsePage(r)
	q := r.URL.Query()
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]map[string]any, 0, len(c.audit))
	for i := len(c.audit) - 1; i >= 0; i-- {
		a := c.audit[i]
		out = append(out, map[string]any{
			"id": a.ID, "ts": a.Ts.UTC().Format(time.RFC3339),
			"actor": a.Actor, "action": a.Action, "target": a.Target, "detail": a.Detail,
			"targetName": c.targetNameLocked(a.Target),
		})
	}
	out = filterAuditViews(out, q.Get("q"), q.Get("action"))
	writeList(w, out, page, size, paged)
}

func (c *Console) getFrames(w http.ResponseWriter, r *http.Request) {
	page, size, paged := parsePage(r)
	c.mu.Lock()
	defer c.mu.Unlock()
	out := append([]frameRec{}, c.frames...)
	writeList(w, out, page, size, paged)
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
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()
	c.absorbAllLocked(stats)
	c.refreshRatesLocked(stats, now)
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
	var liveBpsIn, liveBpsOut float64
	for id, m := range c.maps {
		if mappingID == "" && nodeID == "" || allow[id] {
			liveIn += m.BytesIn
			liveOut += m.BytesOut
			if b, ok := c.bpsBy[id]; ok {
				liveBpsIn += b[0]
				liveBpsOut += b[1]
			}
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
		"bpsIn": int64(liveBpsIn), "bpsOut": int64(liveBpsOut),
		"peakBpsIn": int64(peakIn), "peakBpsOut": int64(peakOut),
		"series": series,
	})
}

func (c *Console) getOverview(w http.ResponseWriter, _ *http.Request) {
	live := c.live()
	stats := c.Gate.MappingStats()
	c.mu.Lock()
	defer c.mu.Unlock()
	c.touchOnlineLocked(live, time.Now())
	c.absorbAllLocked(stats)
	writeJSON(w, c.overviewView(live, stats))
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
	until := lifetimeUntil(rec.TokenNoExpiry)
	old, oldUntil, oldPrev, oldPrevUntil := rec.TokenHash, rec.TokenUntil, rec.PrevHash, rec.PrevUntil
	prevRevoked := c.snapshotRevoked()
	if old != "" && old != hash {
		c.revokeHash(old)
	}
	c.revokeHash(oldPrev)
	rec.TokenHash, rec.TokenUntil = hash, until
	rec.PrevHash, rec.PrevUntil, rec.Token = "", time.Time{}, ""
	if err := c.save(); err != nil {
		rec.TokenHash, rec.TokenUntil, rec.PrevHash, rec.PrevUntil = old, oldUntil, oldPrev, oldPrevUntil
		c.revoked = prevRevoked
		c.mu.Unlock()
		persistFail(w)
		return
	}
	c.Gate.ReplaceToken(rec.ID, hash, until)
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
