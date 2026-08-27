package gate

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"umbra/internal/netutil"
	"umbra/internal/policy"
	"umbra/internal/stealth"
	"umbra/internal/wire"
)

type Mapping = wire.Mapping

type agentConn struct {
	id     string
	addr   string
	os     string
	arch   string
	ver    string
	raw    net.Conn
	conn   *wire.Conn
	online bool
	have   map[string]Mapping
	mu     sync.Mutex
}

type udpSess struct {
	pc     net.PacketConn
	raddr  net.Addr
	sid    uint32
	timer  *time.Timer
	idle   time.Duration
}

type entry struct {
	spec     Mapping
	agentID  string
	ln       net.Listener
	pc       net.PacketConn
	active   int
	window   policy.Window
	udpSess  map[string]*udpSess
}

type Server struct {
	bind    string
	stealth *stealth.Engine
	mu      sync.Mutex
	tok     map[string]string
	ag      map[string]*agentConn
	ent     map[string]*entry
	want    map[string][]Mapping
	grant   map[string]time.Time
	sid     atomic.Uint32
	ctrl    net.Listener
	api     net.Listener
	draining atomic.Bool
}

func New(bind string, st *stealth.Engine) *Server {
	if st == nil {
		st = stealth.New(false)
	}
	return &Server{
		bind:    bind,
		stealth: st,
		tok:     map[string]string{},
		ag:      map[string]*agentConn{},
		ent:     map[string]*entry{},
		want:    map[string][]Mapping{},
		grant:   map[string]time.Time{},
	}
}

func (s *Server) SetListeners(ctrl, api net.Listener) {
	s.ctrl = ctrl
	s.api = api
}

func (s *Server) StealthMode() string { return s.stealth.Mode() }

func (s *Server) ServeControl(ln net.Listener) error {
	for {
		c, err := ln.Accept()
		if err != nil {
			return err
		}
		go s.handleAgent(c)
	}
}

func (s *Server) handleAgent(raw net.Conn) {
	defer raw.Close()
	_ = raw.SetDeadline(time.Time{})
	wc := wire.NewConn(raw)
	var ac *agentConn
	for {
		f, err := wc.Read()
		if err != nil {
			if ac != nil {
				s.offline(ac)
			}
			return
		}
		switch f.Kind {
		case wire.KindJSON:
			if err := s.onJSON(raw, wc, &ac, f); err != nil {
				log.Printf("agent json: %v", err)
				return
			}
		case wire.KindData, wire.KindClose:
			if ac != nil {
				s.onStream(ac, f)
			}
		}
	}
}

func (s *Server) onJSON(raw net.Conn, wc *wire.Conn, ac **agentConn, f wire.Frame) error {
	switch f.Type {
	case "Enroll":
		var b struct {
			Bootstrap string `json:"bootstrap"`
			Hostname  string `json:"hostname"`
			OS        string `json:"os"`
			Arch      string `json:"arch"`
			Version   string `json:"version"`
		}
		if err := json.Unmarshal(f.Body, &b); err != nil {
			return err
		}
		s.mu.Lock()
		id, ok := s.tok[b.Bootstrap]
		s.mu.Unlock()
		if !ok || id == "" {
			_ = wc.SendJSON("Dropped", map[string]string{"reason": "bad_token"})
			return fmt.Errorf("bad token")
		}
		sess := &agentConn{id: id, addr: policy.NormalizeIP(raw.RemoteAddr().String()), os: b.OS, arch: b.Arch, ver: b.Version, raw: raw, conn: wc, online: false, have: map[string]Mapping{}}
		s.mu.Lock()
		if old := s.ag[id]; old != nil && old != sess {
			old.online = false
		}
		s.ag[id] = sess
		s.mu.Unlock()
		*ac = sess
		return wc.SendJSON("EnrollOk", map[string]string{"agent_id": id})
	case "Hello":
		var b struct {
			AgentID string `json:"agent_id"`
			Version string `json:"version"`
		}
		_ = json.Unmarshal(f.Body, &b)
		if *ac == nil {
			s.mu.Lock()
			sess := s.ag[b.AgentID]
			s.mu.Unlock()
			if sess == nil {
				return fmt.Errorf("unknown agent")
			}
			sess.conn = wc
			sess.online = true
			sess.addr = policy.NormalizeIP(raw.RemoteAddr().String())
			*ac = sess
		}
		if b.Version != "" {
			(*ac).ver = b.Version
		}
		(*ac).online = true
		maps := s.mappingsFor((*ac).id)
		return wc.SendJSON("HelloOk", map[string]any{"mappings": maps})
	case "MappingAck", "Heartbeat", "CloseStream":
		return nil
	default:
		return nil
	}
}

func (s *Server) mappingsFor(agentID string) []Mapping {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []Mapping{}
	for _, e := range s.ent {
		if e.agentID == agentID {
			out = append(out, e.spec)
		}
	}
	return out
}

func (s *Server) offline(ac *agentConn) {
	s.mu.Lock()
	if s.ag[ac.id] == ac {
		ac.online = false
	}
	s.mu.Unlock()
}

type streamPipe struct {
	c net.Conn
}

var pipes sync.Map // streamID -> net.Conn or udpSess

func (s *Server) onStream(ac *agentConn, f wire.Frame) {
	v, ok := pipes.Load(f.StreamID)
	if !ok {
		return
	}
	switch p := v.(type) {
	case net.Conn:
		if f.Kind == wire.KindClose {
			_ = p.Close()
			pipes.Delete(f.StreamID)
			return
		}
		_, _ = p.Write(f.Payload)
	case *udpSess:
		if f.Kind == wire.KindClose {
			pipes.Delete(f.StreamID)
			return
		}
		_, _ = p.pc.WriteTo(f.Payload, p.raddr)
	}
}

func (s *Server) SetToken(token, agentID string) {
	s.mu.Lock()
	s.tok[token] = agentID
	s.mu.Unlock()
}

func (s *Server) Revoke(agentID string) {
	s.mu.Lock()
	ac := s.ag[agentID]
	ids := []string{}
	for id, e := range s.ent {
		if e.agentID == agentID {
			ids = append(ids, id)
		}
	}
	s.mu.Unlock()
	if ac != nil {
		_ = ac.conn.SendJSON("Revoked", map[string]any{})
	}
	for _, id := range ids {
		s.stopEntry(id)
	}
	s.mu.Lock()
	delete(s.ag, agentID)
	s.mu.Unlock()
}

func (s *Server) Disconnect(agentID string) {
	s.mu.Lock()
	ac := s.ag[agentID]
	s.mu.Unlock()
	if ac != nil && ac.raw != nil {
		_ = ac.raw.Close()
	}
}

func (s *Server) Knock(mappingID string, ttl time.Duration) time.Time {
	until := time.Now().Add(ttl)
	s.mu.Lock()
	s.grant[mappingID] = until
	e := s.ent[mappingID]
	s.mu.Unlock()
	if e != nil && e.spec.EntryPort != nil {
		s.stealth.Knock(stealth.Port{Proto: e.spec.Proto, Port: uint16(*e.spec.EntryPort)}, ttl)
	}
	return until
}

func (s *Server) granted(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	until, ok := s.grant[id]
	if !ok || time.Now().After(until) {
		delete(s.grant, id)
		return false
	}
	return true
}

func (s *Server) PutMappings(agentID string, maps []Mapping) {
	s.mu.Lock()
	s.want[agentID] = maps
	s.mu.Unlock()
	want := map[string]Mapping{}
	for _, m := range maps {
		if m.Enabled && m.Mode != "visitor" && m.EntryPort != nil {
			want[m.ID] = m
		}
	}
	s.mu.Lock()
	have := []string{}
	for id, e := range s.ent {
		if e.agentID == agentID {
			have = append(have, id)
		}
	}
	s.mu.Unlock()
	for _, id := range have {
		m, ok := want[id]
		if !ok {
			s.stopEntry(id)
			continue
		}
		s.ensureEntry(agentID, m)
		delete(want, id)
	}
	for _, m := range want {
		s.ensureEntry(agentID, m)
	}
	s.mu.Lock()
	ac := s.ag[agentID]
	s.mu.Unlock()
	if ac != nil && ac.online {
		_ = ac.conn.SendJSON("MappingSync", map[string]any{"upsert": maps, "delete": []string{}})
	}
}

func (s *Server) ensureEntry(agentID string, m Mapping) {
	s.mu.Lock()
	cur := s.ent[m.ID]
	if cur != nil && sameListen(cur.spec, m) {
		cur.spec = m
		cur.agentID = agentID
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	s.stopEntry(m.ID)
	if m.EntryPort == nil {
		return
	}
	port := *m.EntryPort
	addr := net.JoinHostPort(s.bind, fmt.Sprintf("%d", port))
	e := &entry{spec: m, agentID: agentID, udpSess: map[string]*udpSess{}}
	if m.Proto == "udp" {
		pc, err := netutil.ListenPacket("udp4", addr)
		if err != nil {
			log.Printf("udp listen %s: %v", addr, err)
			return
		}
		e.pc = pc
		s.mu.Lock()
		s.ent[m.ID] = e
		s.mu.Unlock()
		if m.Mode == "spa" {
			s.stealth.SetSPA(stealth.Port{Proto: "udp", Port: uint16(port)}, true)
		}
		go s.serveUDP(e)
		return
	}
	ln, err := netutil.Listen("tcp", addr)
	if err != nil {
		log.Printf("tcp listen %s: %v", addr, err)
		return
	}
	e.ln = ln
	s.mu.Lock()
	s.ent[m.ID] = e
	s.mu.Unlock()
	if m.Mode == "spa" {
		s.stealth.SetSPA(stealth.Port{Proto: "tcp", Port: uint16(port)}, true)
	}
	go s.serveTCP(e)
}

func sameListen(a, b Mapping) bool {
	ap, bp := 0, 0
	if a.EntryPort != nil {
		ap = *a.EntryPort
	}
	if b.EntryPort != nil {
		bp = *b.EntryPort
	}
	return a.Proto == b.Proto && ap == bp && a.Mode == b.Mode && a.LocalHost == b.LocalHost && a.LocalPort == b.LocalPort
}

func (s *Server) stopEntry(id string) {
	s.mu.Lock()
	e := s.ent[id]
	delete(s.ent, id)
	s.mu.Unlock()
	if e == nil {
		return
	}
	if e.spec.Mode == "spa" && e.spec.EntryPort != nil {
		s.stealth.SetSPA(stealth.Port{Proto: e.spec.Proto, Port: uint16(*e.spec.EntryPort)}, false)
	}
	if e.ln != nil {
		_ = e.ln.Close()
	}
	if e.pc != nil {
		_ = e.pc.Close()
	}
}

func (s *Server) serveTCP(e *entry) {
	for {
		c, err := e.ln.Accept()
		if err != nil {
			return
		}
		go s.handleTCP(e, c)
	}
}

func (s *Server) handleTCP(e *entry, c net.Conn) {
	ip := policy.NormalizeIP(c.RemoteAddr().String())
	if e.spec.Mode == "spa" && !s.granted(e.spec.ID) {
		_ = c.Close()
		return
	}
	if !policy.CidrAllowed(ip, e.spec.AllowCidrs) {
		_ = c.Close()
		return
	}
	s.mu.Lock()
	ac := s.ag[e.agentID]
	online := ac != nil && ac.online
	if e.active >= policy.IntOr(e.spec.MaxConns, 64) {
		s.mu.Unlock()
		_ = c.Close()
		return
	}
	if !online {
		s.mu.Unlock()
		_ = c.Close()
		return
	}
	e.active++
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		e.active--
		s.mu.Unlock()
		_ = c.Close()
	}()
	sid := s.sid.Add(1)
	pipes.Store(sid, c)
	defer pipes.Delete(sid)
	idle := time.Duration(policy.IntOr(e.spec.IdleTimeoutSec, 60)) * time.Second
	_ = ac.conn.SendJSON("OpenStream", map[string]any{
		"stream_id":  sid,
		"mapping_id": e.spec.ID,
		"proto":      "tcp",
		"peer_ip":    ip,
		"peer_port":  portOf(c.RemoteAddr()),
		"via":        e.spec.Mode,
	})
	buf := make([]byte, 32*1024)
	for {
		_ = c.SetReadDeadline(time.Now().Add(idle))
		n, err := c.Read(buf)
		if n > 0 {
			if !e.window.Take(e.spec.RateKbps, n) {
				_ = ac.conn.SendClose(sid)
				return
			}
			if err := ac.conn.SendData(sid, buf[:n]); err != nil {
				return
			}
		}
		if err != nil {
			_ = ac.conn.SendClose(sid)
			return
		}
	}
}

func (s *Server) serveUDP(e *entry) {
	buf := make([]byte, 64*1024)
	for {
		n, raddr, err := e.pc.ReadFrom(buf)
		if err != nil {
			return
		}
		ip := policy.NormalizeIP(raddr.String())
		if e.spec.Mode == "spa" && !s.granted(e.spec.ID) {
			continue
		}
		if !policy.CidrAllowed(ip, e.spec.AllowCidrs) {
			continue
		}
		s.mu.Lock()
		ac := s.ag[e.agentID]
		online := ac != nil && ac.online
		s.mu.Unlock()
		if !online {
			continue
		}
		if !e.window.Take(e.spec.RateKbps, n) {
			continue
		}
		key := raddr.String()
		s.mu.Lock()
		sess := e.udpSess[key]
		idle := time.Duration(policy.IntOr(e.spec.IdleTimeoutSec, 60)) * time.Second
		if sess == nil {
			if e.active >= policy.IntOr(e.spec.MaxConns, 64) {
				s.mu.Unlock()
				continue
			}
			sid := s.sid.Add(1)
			sess = &udpSess{pc: e.pc, raddr: raddr, sid: sid, idle: idle}
			e.udpSess[key] = sess
			e.active++
			pipes.Store(sid, sess)
			s.mu.Unlock()
			_ = ac.conn.SendJSON("OpenStream", map[string]any{
				"stream_id":  sid,
				"mapping_id": e.spec.ID,
				"proto":      "udp",
				"peer_ip":    ip,
				"peer_port":  portOf(raddr),
				"via":        e.spec.Mode,
			})
		} else {
			s.mu.Unlock()
		}
		if sess.timer != nil {
			sess.timer.Stop()
		}
		sid := sess.sid
		sess.timer = time.AfterFunc(idle, func() {
			s.mu.Lock()
			if e.udpSess[key] == sess {
				delete(e.udpSess, key)
				e.active--
			}
			s.mu.Unlock()
			pipes.Delete(sid)
			_ = ac.conn.SendClose(sid)
		})
		_ = ac.conn.SendData(sid, buf[:n])
	}
}

func portOf(a net.Addr) int {
	if ta, ok := a.(*net.TCPAddr); ok {
		return ta.Port
	}
	if ua, ok := a.(*net.UDPAddr); ok {
		return ua.Port
	}
	_, p, _ := net.SplitHostPort(a.String())
	return policy.Atoi(p)
}

type statusAgent struct {
	ID     string `json:"id"`
	Online bool   `json:"online"`
	Addr   string `json:"addr"`
	OS     string `json:"os"`
	Arch   string `json:"arch"`
	Ver    string `json:"version"`
}

type Status struct {
	Agents  []statusAgent `json:"agents"`
	Stealth string        `json:"stealth"`
	Active  int           `json:"active"`
}

func (s *Server) Active() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, e := range s.ent {
		n += e.active
	}
	return n
}

func (s *Server) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []statusAgent{}
	for _, a := range s.ag {
		out = append(out, statusAgent{ID: a.id, Online: a.online, Addr: a.addr, OS: a.os, Arch: a.arch, Ver: a.ver})
	}
	n := 0
	for _, e := range s.ent {
		n += e.active
	}
	return Status{Agents: out, Stealth: s.stealth.Mode(), Active: n}
}

type Snapshot struct {
	Tokens map[string]string         `json:"tokens"`
	Maps   map[string][]Mapping      `json:"maps"`
	Grants map[string]int64          `json:"grants"`
}

func (s *Server) Snapshot() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	g := map[string]int64{}
	for id, t := range s.grant {
		if t.After(time.Now()) {
			g[id] = t.UnixMilli()
		}
	}
	tok := map[string]string{}
	for k, v := range s.tok {
		tok[k] = v
	}
	maps := map[string][]Mapping{}
	for k, v := range s.want {
		maps[k] = v
	}
	return Snapshot{Tokens: tok, Maps: maps, Grants: g}
}

func (s *Server) RestoreTokens(tokens map[string]string) {
	for tok, id := range tokens {
		s.SetToken(tok, id)
	}
}

func (s *Server) Restore(snap Snapshot) {
	s.RestoreTokens(snap.Tokens)
	for id, maps := range snap.Maps {
		s.PutMappings(id, maps)
	}
	for id, ms := range snap.Grants {
		until := time.UnixMilli(ms)
		if until.After(time.Now()) {
			s.Knock(id, time.Until(until))
		}
	}
}

func (s *Server) StopAccept() {
	s.draining.Store(true)
	if s.ctrl != nil {
		_ = s.ctrl.Close()
	}
	if s.api != nil {
		_ = s.api.Close()
	}
	s.mu.Lock()
	ents := []*entry{}
	for _, e := range s.ent {
		ents = append(ents, e)
	}
	s.mu.Unlock()
	for _, e := range ents {
		if e.ln != nil {
			_ = e.ln.Close()
		}
		if e.pc != nil {
			_ = e.pc.Close()
		}
	}
}

func (s *Server) WaitIdle(d time.Duration) {
	t0 := time.Now()
	for time.Since(t0) < d {
		if s.Active() == 0 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func (s *Server) ServeAPI(ln net.Listener) error {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc("PUT /v1/tokens/{token}", func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			AgentID string `json:"agent_id"`
		}
		_ = json.NewDecoder(r.Body).Decode(&b)
		s.SetToken(r.PathValue("token"), b.AgentID)
		w.WriteHeader(204)
	})
	mux.HandleFunc("PUT /v1/agents/{id}/mappings", func(w http.ResponseWriter, r *http.Request) {
		var maps []Mapping
		if err := json.NewDecoder(r.Body).Decode(&maps); err != nil && err != io.EOF {
			http.Error(w, err.Error(), 400)
			return
		}
		s.PutMappings(r.PathValue("id"), maps)
		w.WriteHeader(204)
	})
	mux.HandleFunc("POST /v1/agents/{id}/revoke", func(w http.ResponseWriter, r *http.Request) {
		s.Revoke(r.PathValue("id"))
		w.WriteHeader(204)
	})
	mux.HandleFunc("POST /v1/agents/{id}/disconnect", func(w http.ResponseWriter, r *http.Request) {
		s.Disconnect(r.PathValue("id"))
		w.WriteHeader(204)
	})
	mux.HandleFunc("POST /v1/knock/{id}", func(w http.ResponseWriter, r *http.Request) {
		until := s.Knock(r.PathValue("id"), 60*time.Second)
		_ = json.NewEncoder(w).Encode(map[string]string{"until": until.UTC().Format(time.RFC3339)})
	})
	mux.HandleFunc("GET /v1/status", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(s.Status())
	})
	return http.Serve(ln, mux)
}
