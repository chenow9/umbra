package gate

import (
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/hashicorp/yamux"

	"umbra/internal/muxcfg"
	"umbra/internal/netutil"
	"umbra/internal/policy"
	"umbra/internal/preface"
	"umbra/internal/stealth"
	"umbra/internal/uplane"
	"umbra/internal/wire"
	"umbra/internal/xfer"
)

const (
	maxHandshake      = 64
	maxHandshakePerIP = 16
	maxSessions       = 1024
	maxSessionsPerIP  = 128
)

var (
	handshakeDeadlineNs atomic.Int64
	maxSplices          atomic.Int32
	listenRetryWait     = 100 * time.Millisecond
	listenRetryMax      = 8 * time.Second
	listenTCPFn         atomic.Value
	listenPacketFn      atomic.Value
)

type listenTCPFunc func(network, addr string) (net.Listener, error)
type listenPacketFunc func(network, addr string) (net.PacketConn, error)

func init() {
	handshakeDeadlineNs.Store(int64(12 * time.Second))
	listenTCPFn.Store(listenTCPFunc(netutil.Listen))
	listenPacketFn.Store(listenPacketFunc(netutil.ListenPacket))
	maxSplices.Store(8192)
	if v := os.Getenv("UMBRA_MAX_SPLICES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			maxSplices.Store(int32(n))
		}
	}
}

func doListenTCP(network, addr string) (net.Listener, error) {
	return listenTCPFn.Load().(listenTCPFunc)(network, addr)
}

func doListenPacket(network, addr string) (net.PacketConn, error) {
	return listenPacketFn.Load().(listenPacketFunc)(network, addr)
}

type Mapping = wire.Mapping

type nodeConn struct {
	id        string
	credHash  string
	addr      string
	os        string
	arch      string
	ver       string
	raw       net.Conn
	sess      *yamux.Session
	conn      *wire.Conn
	online    bool
	udpCookie []byte
	udpAddr   net.Addr
	udpBindOK bool
	udpBound  bool
	udpSeen   atomic.Int64
	udpIn     *uplane.Opener
	udpOut    *uplane.Sealer
}

type udpSess struct {
	pc       net.PacketConn
	raddr    net.Addr
	st       net.Conn
	timer    *time.Timer
	idle     time.Duration
	deadline atomic.Int64
	visitID  string
	flowID   string
	peerKey  string
	path     int32
}

const (
	udpPathNone   int32 = 0
	udpPathUPlane int32 = 1
	udpPathYamux  int32 = 2
)

type UDPMode string

const (
	UDPAuto     UDPMode = "auto"
	UDPRequired UDPMode = "required"
	UDPYamux    UDPMode = "yamux"
)

func ParseUDPMode(s string) UDPMode {
	switch s {
	case "required", "uplane-required", "uplane":
		return UDPRequired
	case "yamux":
		return UDPYamux
	default:
		return UDPAuto
	}
}

type entry struct {
	spec         Mapping
	nodeID       string
	ln           net.Listener
	pc           net.PacketConn
	listenErr    string
	mu           sync.Mutex
	window       policy.Window
	udpSess      map[string]*udpSess
	active       atomic.Int32
	in           atomic.Int64
	out          atomic.Int64
	pin          atomic.Int64
	pout         atomic.Int64
	stopCh       chan struct{}
	stopOnce     sync.Once
	udpViaUplane atomic.Bool
	udpViaYamux  atomic.Bool
}

type ticketEnt struct {
	MappingID string
	Until     time.Time
}

type tokenEnt struct {
	NodeID string
	Until  time.Time
}

// TokenGrace is how long a replaced node credential remains valid
// so the operator can update the node before the old hash is dropped.
var TokenGrace = 90 * time.Second

// TokenTTL is the lifetime of a current node credential. Zero Until
// is only for tests; the control plane always sets an expiry.
var TokenTTL = 90 * 24 * time.Hour

type Server struct {
	bind      string
	stealth   *stealth.Engine
	tls       *tls.Config
	mu        sync.Mutex
	tok       map[string]tokenEnt
	nodes     map[string]*nodeConn
	ent       map[string]*entry
	want      map[string][]Mapping
	grant     map[string]time.Time
	tix       map[string]ticketEnt
	visits    map[string]*visitUDP
	ctrl      net.Listener
	api       net.Listener
	udpPC     net.PacketConn
	udpMode   UDPMode
	hsQuota   *ipQuota
	sessQuota *ipQuota
	splices   atomic.Int32
	draining  atomic.Bool
	acked     map[string]int64
	ackErr    map[string]bool
	obs       Observer
}

type Observer interface {
	Audit(action, target, detail string)
	Frame(nodeID, dir, typ, body string)
}

func New(bind string, st *stealth.Engine) *Server {
	if st == nil {
		st = stealth.New(false)
	}
	return &Server{
		bind:      bind,
		stealth:   st,
		tok:       map[string]tokenEnt{},
		nodes:     map[string]*nodeConn{},
		ent:       map[string]*entry{},
		want:      map[string][]Mapping{},
		grant:     map[string]time.Time{},
		tix:       map[string]ticketEnt{},
		visits:    map[string]*visitUDP{},
		udpMode:   UDPAuto,
		hsQuota:   newIPQuota(maxHandshake, maxHandshakePerIP),
		sessQuota: newIPQuota(maxSessions, maxSessionsPerIP),
		acked:     map[string]int64{},
		ackErr:    map[string]bool{},
	}
}

func (s *Server) SetObserver(o Observer) { s.obs = o }

func (s *Server) noteAudit(action, target, detail string) {
	if s.obs != nil {
		s.obs.Audit(action, target, detail)
	}
}

func (s *Server) noteFrame(nodeID, dir, typ string, body []byte) {
	if s.obs == nil {
		return
	}
	const max = 240
	b := string(body)
	if len(b) > max {
		b = b[:max] + "…"
	}
	s.obs.Frame(nodeID, dir, typ, b)
}

func (s *Server) SetUDPMode(m UDPMode) {
	if m == "" {
		m = UDPAuto
	}
	s.udpMode = m
}

type ipQuota struct {
	mu     sync.Mutex
	n      map[string]int
	total  int
	global int
	limit  int
}

func newIPQuota(global, perIP int) *ipQuota {
	return &ipQuota{
		n:      map[string]int{},
		global: global,
		limit:  perIP,
	}
}

func (q *ipQuota) acquire(ip string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.total >= q.global || q.n[ip] >= q.limit {
		return false
	}
	q.n[ip]++
	q.total++
	return true
}

func (q *ipQuota) release(ip string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.n[ip] <= 0 {
		return
	}
	q.n[ip]--
	q.total--
	if q.n[ip] == 0 {
		delete(q.n, ip)
	}
}

func (q *ipQuota) held(ip string) int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.n[ip]
}

func (s *Server) SetTLS(cfg *tls.Config) { s.tls = cfg }

func TicketHash(ticket string) string {
	sum := sha256.Sum256([]byte(ticket))
	return hex.EncodeToString(sum[:])
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
			if s.draining.Load() {
				return err
			}
			time.Sleep(80 * time.Millisecond)
			continue
		}
		go s.handleConn(c)
	}
}

func (s *Server) admitHS(ip string) bool      { return s.hsQuota.acquire(ip) }
func (s *Server) releaseHS(ip string)         { s.hsQuota.release(ip) }
func (s *Server) admitSess(ip string) bool    { return s.sessQuota.acquire(ip) }
func (s *Server) releaseSess(ip string)       { s.sessQuota.release(ip) }
func (s *Server) handshakeHeld(ip string) int { return s.hsQuota.held(ip) }
func (s *Server) sessionHeld(ip string) int   { return s.sessQuota.held(ip) }

func (s *Server) handleConn(raw net.Conn) {
	defer raw.Close()
	ip := policy.NormalizeIP(raw.RemoteAddr().String())
	if !s.admitHS(ip) {
		slog.Info("handshake rejected", "ip", ip, "reason", "quota")
		return
	}
	hsHeld := true
	defer func() {
		if hsHeld {
			s.releaseHS(ip)
		}
	}()
	deadline := time.Now().Add(time.Duration(handshakeDeadlineNs.Load()))
	_ = raw.SetDeadline(deadline)
	if s.tls != nil {
		tc := tls.Server(raw, s.tls.Clone())
		if err := tc.Handshake(); err != nil {
			return
		}
		raw = tc
		_ = raw.SetDeadline(deadline)
	}
	kind, cred, err := preface.Read(raw)
	if err != nil {
		return
	}
	var enrollID, enrollHash string
	switch kind {
	case preface.KindNode:
		id, h, ok := s.lookupCred(cred)
		if !ok {
			return
		}
		enrollID, enrollHash = id, h
	case preface.KindVisit:
		if _, ok := s.lookupTicket(TicketHash(cred)); !ok {
			return
		}
	default:
		return
	}
	s.releaseHS(ip)
	hsHeld = false

	if !s.admitSess(ip) {
		return
	}
	defer s.releaseSess(ip)

	sess, err := yamux.Server(raw, muxcfg.Config())
	if err != nil {
		return
	}
	defer sess.Close()
	_ = raw.SetDeadline(deadline)
	ctrl, err := sess.AcceptStream()
	if err != nil {
		return
	}
	wc := wire.NewConn(ctrl)
	_ = ctrl.SetDeadline(deadline)
	env, err := wc.Read()
	if err != nil {
		return
	}
	_ = ctrl.SetDeadline(time.Time{})
	_ = raw.SetDeadline(time.Time{})
	switch env.Type {
	case "Enroll":
		s.runNode(raw, sess, wc, env, enrollID, enrollHash)
	case "Visit":
		s.runVisitor(raw, sess, wc, env)
	default:
		_ = wc.SendJSON("Dropped", map[string]string{"reason": "bad_hello"})
	}
}

func (s *Server) runNode(raw net.Conn, sess *yamux.Session, wc *wire.Conn, first wire.Envelope, nodeID, credHash string) {
	var ac *nodeConn
	if err := s.onJSON(raw, sess, wc, &ac, first, nodeID, credHash); err != nil {
		log.Printf("node json: %v", err)
		return
	}
	var nmsg int
	var win time.Time
	for {
		env, err := wc.Read()
		if err != nil {
			if ac != nil {
				s.offline(ac)
			}
			return
		}
		now := time.Now()
		if now.Sub(win) > time.Second {
			win, nmsg = now, 0
		}
		nmsg++
		if nmsg > 64 {
			slog.Info("control flood", "node", nodeID, "reason", "rate")
			continue
		}
		if err := s.onJSON(raw, sess, wc, &ac, env, nodeID, credHash); err != nil {
			log.Printf("node json: %v", err)
			if ac != nil {
				s.offline(ac)
			}
			return
		}
	}
}

func (s *Server) onJSON(raw net.Conn, sess *yamux.Session, wc *wire.Conn, ac **nodeConn, env wire.Envelope, nodeID, credHash string) error {
	switch env.Type {
	case "Enroll":
		var b struct {
			Hostname string `json:"hostname"`
			OS       string `json:"os"`
			Arch     string `json:"arch"`
			Version  string `json:"version"`
		}
		if err := json.Unmarshal(env.Body, &b); err != nil {
			return err
		}
		if nodeID == "" || credHash == "" {
			_ = wc.SendJSON("Dropped", map[string]string{"reason": "bad_token"})
			return fmt.Errorf("missing preface identity")
		}
		sessn := &nodeConn{
			id: nodeID, credHash: credHash, addr: policy.NormalizeIP(raw.RemoteAddr().String()),
			os: b.OS, arch: b.Arch, ver: b.Version, raw: raw, sess: sess, conn: wc, online: false,
		}
		s.mu.Lock()
		id, ok := s.admitHashLocked(credHash, nodeID)
		if !ok {
			s.mu.Unlock()
			_ = wc.SendJSON("Dropped", map[string]string{"reason": "bad_token"})
			return fmt.Errorf("credential rejected at enroll")
		}
		sessn.id = id
		if old := s.nodes[id]; old != nil && old != sessn {
			old.online = false
			s.clearNodeUDP(old)
			if old.sess != nil && old.sess != sess {
				_ = old.sess.Close()
			}
		}
		s.nodes[id] = sessn
		s.mu.Unlock()
		*ac = sessn
		s.noteFrame(id, "c2s", "Enroll", env.Body)
		s.noteAudit("node.enroll", id, policy.NormalizeIP(raw.RemoteAddr().String()))
		return wc.SendJSON("EnrollOk", map[string]string{"node_id": id})
	case "Hello":
		var b struct {
			NodeID  string `json:"node_id"`
			Version string `json:"version"`
		}
		_ = json.Unmarshal(env.Body, &b)
		s.mu.Lock()
		if *ac == nil {
			found := s.nodes[b.NodeID]
			if found == nil {
				s.mu.Unlock()
				return fmt.Errorf("unknown agent")
			}
			*ac = found
		}
		cur := *ac
		cur.conn = wc
		cur.sess = sess
		cur.raw = raw
		cur.online = true
		cur.addr = policy.NormalizeIP(raw.RemoteAddr().String())
		if b.Version != "" {
			cur.ver = b.Version
		}
		id := cur.id
		s.mu.Unlock()
		maps := s.mappingsFor(id)
		hello := map[string]any{"mappings": maps, "udp_mode": string(s.udpMode)}
		if keys := s.issueUDP(raw); keys != nil {
			s.mu.Lock()
			cur.udpCookie = keys.cookie
			cur.udpIn = keys.in
			cur.udpOut = keys.out
			s.mu.Unlock()
			hello["udp_cookie"] = hexCookie(keys.cookie)
		}
		s.noteFrame(id, "s2c", "HelloOk", nil)
		return wc.SendJSON("HelloOk", hello)
	case "MappingAck":
		var b struct {
			ID         string `json:"id"`
			OK         bool   `json:"ok"`
			Generation int64  `json:"generation"`
		}
		_ = json.Unmarshal(env.Body, &b)
		nid := ""
		if ac != nil && *ac != nil {
			nid = (*ac).id
		}
		s.recordAck(b.ID, b.Generation, b.OK)
		s.noteFrame(nid, "c2s", "MappingAck", env.Body)
		if b.OK {
			s.noteAudit("mapping.ack", b.ID, fmt.Sprintf("generation %d", b.Generation))
		} else {
			s.noteAudit("mapping.ack_fail", b.ID, fmt.Sprintf("generation %d", b.Generation))
		}
		return nil
	case "Heartbeat":
		return nil
	default:
		return nil
	}
}

func (s *Server) mappingsFor(nodeID string) []Mapping {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []Mapping{}
	for _, m := range s.want[nodeID] {
		out = append(out, m)
	}
	return out
}

func (s *Server) offline(ac *nodeConn) {
	s.mu.Lock()
	if s.nodes[ac.id] != ac {
		s.mu.Unlock()
		return
	}
	ac.online = false
	s.clearNodeUDP(ac)
	id := ac.id
	s.mu.Unlock()
	s.noteAudit("node.offline", id, "")
}

func (s *Server) LookupToken(token string) string { return s.lookupToken(token) }

func (s *Server) lookupToken(token string) string {
	id, _, ok := s.lookupCred(token)
	if !ok {
		return ""
	}
	return id
}

func (s *Server) lookupCred(token string) (nodeID, hash string, ok bool) {
	hash = TicketHash(token)
	s.mu.Lock()
	defer s.mu.Unlock()
	e, found := s.tok[hash]
	if !found {
		return "", hash, false
	}
	if tokenExpired(e.Until) {
		delete(s.tok, hash)
		return "", hash, false
	}
	return e.NodeID, hash, true
}

func tokenExpired(until time.Time) bool {
	return !until.IsZero() && !time.Now().Before(until)
}

// admitHashLocked re-checks the authoritative token table. Caller must hold s.mu.
func (s *Server) admitHashLocked(hash, wantID string) (nodeID string, ok bool) {
	e, found := s.tok[hash]
	if !found {
		return "", false
	}
	if tokenExpired(e.Until) {
		delete(s.tok, hash)
		return "", false
	}
	if wantID != "" && e.NodeID != wantID {
		return "", false
	}
	return e.NodeID, true
}

// TokenGraceUntil is min(oldUntil, now+grace). A already-expired token gets no grace.
func TokenGraceUntil(oldUntil time.Time, grace time.Duration) (time.Time, bool) {
	if grace <= 0 {
		grace = TokenGrace
	}
	if tokenExpired(oldUntil) {
		return time.Time{}, false
	}
	end := time.Now().Add(grace)
	if !oldUntil.IsZero() && oldUntil.Before(end) {
		end = oldUntil
	}
	return end, true
}

func (s *Server) SetToken(token, nodeID string) {
	s.SetTokenHash(TicketHash(token), nodeID)
}

func (s *Server) SetTokenHash(hash, nodeID string) {
	s.SetTokenHashUntil(hash, nodeID, time.Time{})
}

func (s *Server) SetTokenHashUntil(hash, nodeID string, until time.Time) {
	if hash == "" || nodeID == "" {
		return
	}
	s.mu.Lock()
	s.tok[hash] = tokenEnt{NodeID: nodeID, Until: until}
	s.mu.Unlock()
}

// ReplaceToken installs newHash as the only credential for nodeID and
// drops every other hash for that node. Sessions still bound to an old
// hash are closed after the table update.
func (s *Server) ReplaceToken(nodeID, newHash string, until time.Time) {
	if nodeID == "" || newHash == "" {
		return
	}
	if until.IsZero() {
		until = time.Now().Add(TokenTTL)
	}
	s.mu.Lock()
	for h, e := range s.tok {
		if e.NodeID == nodeID && h != newHash {
			delete(s.tok, h)
		}
	}
	s.tok[newHash] = tokenEnt{NodeID: nodeID, Until: until}
	ac := s.nodes[nodeID]
	kick := ac != nil && ac.credHash != newHash
	s.mu.Unlock()
	if kick {
		if ac.sess != nil {
			_ = ac.sess.Close()
		} else if ac.raw != nil {
			_ = ac.raw.Close()
		}
	}
}

func (s *Server) RotateToken(nodeID, oldHash, newHash string, grace time.Duration) {
	s.RotateTokenUntil(nodeID, oldHash, newHash, time.Now().Add(TokenTTL), grace)
}

func (s *Server) RotateTokenUntil(nodeID, oldHash, newHash string, until time.Time, grace time.Duration) {
	if grace <= 0 {
		grace = TokenGrace
	}
	if until.IsZero() {
		until = time.Now().Add(TokenTTL)
	}
	s.mu.Lock()
	var oldUntil time.Time
	if oldHash != "" {
		if e, ok := s.tok[oldHash]; ok {
			oldUntil = e.Until
		} else {
			oldUntil = time.Now().Add(-time.Second)
		}
	}
	s.mu.Unlock()
	s.SetTokenHashUntil(newHash, nodeID, until)
	if oldHash != "" && oldHash != newHash {
		if g, ok := TokenGraceUntil(oldUntil, grace); ok {
			s.SetTokenHashUntil(oldHash, nodeID, g)
			delay := time.Until(g)
			if delay < time.Millisecond {
				delay = time.Millisecond
			}
			h := oldHash
			time.AfterFunc(delay, func() { s.ExpireTokenHash(h) })
		} else {
			s.mu.Lock()
			delete(s.tok, oldHash)
			s.mu.Unlock()
		}
	}
	s.Disconnect(nodeID)
}

func (s *Server) ExpireTokenHash(h string) {
	s.mu.Lock()
	e, ok := s.tok[h]
	kick := ""
	if ok && tokenExpired(e.Until) {
		delete(s.tok, h)
		if ac := s.nodes[e.NodeID]; ac != nil && ac.credHash == h {
			kick = e.NodeID
		}
	}
	s.mu.Unlock()
	if kick != "" {
		s.Disconnect(kick)
	}
}

func (s *Server) SetTicket(hash, mappingID string, until time.Time) {
	s.mu.Lock()
	s.tix[hash] = ticketEnt{MappingID: mappingID, Until: until}
	s.mu.Unlock()
}

func (s *Server) DeleteTicket(hash string) {
	s.mu.Lock()
	delete(s.tix, hash)
	s.mu.Unlock()
}

func (s *Server) DeleteTicketsFor(mappingID string) {
	s.mu.Lock()
	for h, t := range s.tix {
		if t.MappingID == mappingID {
			delete(s.tix, h)
		}
	}
	s.mu.Unlock()
}

func (s *Server) lookupTicket(hash string) (ticketEnt, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.tix[hash]
	if !ok {
		return ticketEnt{}, false
	}
	if !t.Until.IsZero() && time.Now().After(t.Until) {
		delete(s.tix, hash)
		return ticketEnt{}, false
	}
	return t, true
}

func (s *Server) mappingByID(id string) (Mapping, string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.ent[id]
	if e != nil {
		return e.spec, e.nodeID, true
	}
	for aid, maps := range s.want {
		for _, m := range maps {
			if m.ID == id {
				return m, aid, true
			}
		}
	}
	return Mapping{}, "", false
}

func (s *Server) Revoke(nodeID string) {
	s.mu.Lock()
	ac := s.nodes[nodeID]
	delete(s.nodes, nodeID)
	for h, e := range s.tok {
		if e.NodeID == nodeID {
			delete(s.tok, h)
		}
	}
	ids := []string{}
	for id, e := range s.ent {
		if e.nodeID == nodeID {
			ids = append(ids, id)
		}
	}
	s.mu.Unlock()
	if ac != nil {
		if ac.conn != nil {
			_ = ac.conn.SendJSON("Revoked", map[string]any{})
		}
		if ac.sess != nil {
			_ = ac.sess.Close()
		} else if ac.raw != nil {
			_ = ac.raw.Close()
		}
	}
	for _, id := range ids {
		s.stopEntry(id)
	}
}

func (s *Server) Disconnect(nodeID string) {
	s.mu.Lock()
	ac := s.nodes[nodeID]
	s.mu.Unlock()
	if ac != nil {
		if ac.sess != nil {
			_ = ac.sess.Close()
		} else if ac.raw != nil {
			_ = ac.raw.Close()
		}
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

func (s *Server) PutMappings(nodeID string, maps []Mapping) {
	s.mu.Lock()
	s.want[nodeID] = maps
	s.mu.Unlock()
	want := map[string]Mapping{}
	for _, m := range maps {
		if m.Enabled {
			want[m.ID] = m
		}
	}
	s.mu.Lock()
	have := []string{}
	for id, e := range s.ent {
		if e.nodeID == nodeID {
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
		s.ensureEntry(nodeID, m)
		delete(want, id)
	}
	for _, m := range want {
		s.ensureEntry(nodeID, m)
	}
	s.mu.Lock()
	ac := s.nodes[nodeID]
	s.mu.Unlock()
	if ac != nil && ac.online && ac.conn != nil {
		_ = ac.conn.SendJSON("MappingSync", map[string]any{"upsert": maps, "delete": []string{}})
		s.noteFrame(nodeID, "s2c", "MappingSync", nil)
	}
}

func (s *Server) recordAck(id string, gen int64, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if id == "" {
		return
	}
	if !ok {
		s.ackErr[id] = true
		return
	}
	delete(s.ackErr, id)
	want := int64(0)
	if e := s.ent[id]; e != nil {
		want = e.spec.Generation
	} else {
		for _, maps := range s.want {
			for _, m := range maps {
				if m.ID == id {
					want = m.Generation
				}
			}
		}
	}
	if gen == 0 || gen == want {
		if want == 0 {
			s.acked[id] = 1
		} else {
			s.acked[id] = want
		}
	}
}

func ackedOK(acked int64, gen int64, failed bool) bool {
	if failed {
		return false
	}
	if gen <= 0 {
		return acked > 0
	}
	return acked >= gen
}

func (s *Server) ensureEntry(nodeID string, m Mapping) {
	listen := m.Mode != "visitor" && m.EntryPort != nil
	s.mu.Lock()
	cur := s.ent[m.ID]
	listening := cur != nil && cur.listenErr == "" && (cur.ln != nil || cur.pc != nil || !listen)
	if cur != nil && sameListen(cur.spec, m) && listening {
		cur.spec = m
		cur.nodeID = nodeID
		s.mu.Unlock()
		return
	}
	var in, out, pin, pout int64
	if cur != nil {
		in, out = cur.in.Load(), cur.out.Load()
		pin, pout = cur.pin.Load(), cur.pout.Load()
	}
	s.mu.Unlock()
	s.stopEntry(m.ID)
	e := &entry{spec: m, nodeID: nodeID, udpSess: map[string]*udpSess{}, stopCh: make(chan struct{})}
	e.in.Store(in)
	e.out.Store(out)
	e.pin.Store(pin)
	e.pout.Store(pout)
	s.mu.Lock()
	if s.draining.Load() {
		s.mu.Unlock()
		return
	}
	s.ent[m.ID] = e
	s.mu.Unlock()
	if !listen {
		return
	}
	ln, pc, err := s.bindListen(e)
	if err != nil {
		log.Printf("listen %s: %v", net.JoinHostPort(s.bind, fmt.Sprintf("%d", *m.EntryPort)), err)
		s.mu.Lock()
		if s.ent[m.ID] == e {
			e.listenErr = err.Error()
		}
		s.mu.Unlock()
		go s.retryListen(e)
		return
	}
	if !s.installListener(e, ln, pc) {
		if ln != nil {
			_ = ln.Close()
		}
		if pc != nil {
			_ = pc.Close()
		}
		return
	}
	s.startServe(e)
}

func (s *Server) bindListen(e *entry) (net.Listener, net.PacketConn, error) {
	port := *e.spec.EntryPort
	addr := net.JoinHostPort(s.bind, fmt.Sprintf("%d", port))
	if e.spec.Proto == "udp" {
		pc, err := doListenPacket("udp4", addr)
		return nil, pc, err
	}
	ln, err := doListenTCP("tcp", addr)
	return ln, nil, err
}

func (s *Server) stoppedLocked(e *entry) bool {
	if s.draining.Load() || s.ent[e.spec.ID] != e || !e.spec.Enabled {
		return true
	}
	select {
	case <-e.stopCh:
		return true
	default:
		return false
	}
}

func (s *Server) installListener(e *entry, ln net.Listener, pc net.PacketConn) bool {
	s.mu.Lock()
	if s.stoppedLocked(e) {
		s.mu.Unlock()
		return false
	}
	e.ln = ln
	e.pc = pc
	e.listenErr = ""
	spa := e.spec.Mode == "spa" && e.spec.EntryPort != nil
	proto := e.spec.Proto
	var port uint16
	if spa {
		port = uint16(*e.spec.EntryPort)
	}
	s.mu.Unlock()
	if spa {
		s.stealth.SetSPA(stealth.Port{Proto: proto, Port: port}, true)
	}
	return true
}

func (s *Server) startServe(e *entry) {
	s.mu.Lock()
	ln, pc := e.ln, e.pc
	udp := e.spec.Proto == "udp"
	s.mu.Unlock()
	if udp {
		go s.serveUDP(e, pc)
		return
	}
	go s.serveTCP(e, ln)
}

func (s *Server) retryListen(e *entry) {
	wait := listenRetryWait
	for {
		select {
		case <-e.stopCh:
			return
		case <-time.After(wait):
		}
		s.mu.Lock()
		live := !s.stoppedLocked(e)
		s.mu.Unlock()
		if !live {
			return
		}
		ln, pc, err := s.bindListen(e)
		if err != nil {
			s.mu.Lock()
			if s.ent[e.spec.ID] == e {
				e.listenErr = err.Error()
			}
			s.mu.Unlock()
			if wait < listenRetryMax {
				wait *= 2
				if wait > listenRetryMax {
					wait = listenRetryMax
				}
			}
			continue
		}
		if !s.installListener(e, ln, pc) {
			if ln != nil {
				_ = ln.Close()
			}
			if pc != nil {
				_ = pc.Close()
			}
			return
		}
		s.startServe(e)
		return
	}
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
	var ln net.Listener
	var pc net.PacketConn
	if e != nil {
		e.stop()
		ln, pc = e.ln, e.pc
	}
	s.mu.Unlock()
	if e == nil {
		return
	}
	if e.spec.Mode == "spa" && e.spec.EntryPort != nil {
		s.stealth.SetSPA(stealth.Port{Proto: e.spec.Proto, Port: uint16(*e.spec.EntryPort)}, false)
	}
	if ln != nil {
		_ = ln.Close()
	}
	if pc != nil {
		_ = pc.Close()
	}
}

func (e *entry) stop() {
	e.stopOnce.Do(func() {
		if e.stopCh != nil {
			close(e.stopCh)
		}
	})
}

func (s *Server) serveTCP(e *entry, ln net.Listener) {
	if ln == nil {
		return
	}
	for {
		c, err := ln.Accept()
		if err != nil {
			if s.draining.Load() {
				return
			}
			select {
			case <-e.stopCh:
				return
			default:
			}
			var ne net.Error
			if errors.As(err, &ne) && ne.Temporary() {
				time.Sleep(80 * time.Millisecond)
				continue
			}
			return
		}
		go s.handleTCP(e, c, e.spec.Mode)
	}
}

func (s *Server) handleTCP(e *entry, c net.Conn, via string) {
	ip := policy.NormalizeIP(c.RemoteAddr().String())
	if e.spec.Mode == "spa" && !s.granted(e.spec.ID) {
		_ = c.Close()
		return
	}
	if !policy.CidrAllowed(ip, e.spec.AllowCidrs) {
		slog.Info("acl drop", "mapping", e.spec.ID, "ip", ip)
		s.noteAudit("acl.drop", e.spec.ID, ip)
		_ = c.Close()
		return
	}
	if !e.reserve() {
		slog.Info("maxconns drop", "mapping", e.spec.ID, "ip", ip)
		_ = c.Close()
		return
	}
	defer e.release()
	if !s.reserveSplice() {
		_ = c.Close()
		return
	}
	defer s.releaseSplice()
	s.mu.Lock()
	ac := s.nodes[e.nodeID]
	var sess *yamux.Session
	if ac != nil && ac.online {
		sess = ac.sess
	}
	s.mu.Unlock()
	if sess == nil {
		_ = c.Close()
		return
	}
	st, err := sess.OpenStream()
	if err != nil {
		_ = c.Close()
		return
	}
	if err := wire.WriteOpen(st, wire.StreamOpen{
		MappingID: e.spec.ID, Proto: "tcp", PeerIP: ip, PeerPort: portOf(c.RemoteAddr()), Via: via,
	}); err != nil {
		_ = st.Close()
		_ = c.Close()
		return
	}
	idle := time.Duration(policy.IntOr(e.spec.IdleTimeoutSec, 60)) * time.Second
	pub := &idleConn{Conn: c, idle: idle}
	dst := xfer.WithLimit(st, e.take)
	xfer.CopyBidirectional(dst, pub, &e.in, &e.out)
}

func (e *entry) reserve() bool {
	max := int32(policy.IntOr(e.spec.MaxConns, 64))
	for {
		cur := e.active.Load()
		if cur >= max {
			return false
		}
		if e.active.CompareAndSwap(cur, cur+1) {
			return true
		}
	}
}

func (e *entry) release() {
	if e != nil {
		e.active.Add(-1)
	}
}

func (s *Server) reserveSplice() bool {
	max := maxSplices.Load()
	if max <= 0 {
		max = 8192
	}
	for {
		cur := s.splices.Load()
		if cur >= max {
			return false
		}
		if s.splices.CompareAndSwap(cur, cur+1) {
			return true
		}
	}
}

func (s *Server) releaseSplice() { s.splices.Add(-1) }

func (e *entry) take(n int) bool {
	if e.spec.RateKbps <= 0 {
		return true
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.window.Take(e.spec.RateKbps, n)
}

type idleConn struct {
	net.Conn
	idle time.Duration
}

func (c *idleConn) touch() {
	if c.idle > 0 {
		_ = c.Conn.SetDeadline(time.Now().Add(c.idle))
	}
}

func (c *idleConn) Read(p []byte) (int, error) {
	c.touch()
	return c.Conn.Read(p)
}

func (c *idleConn) Write(p []byte) (int, error) {
	c.touch()
	return c.Conn.Write(p)
}

func (c *idleConn) CloseWrite() error {
	if t, ok := c.Conn.(*net.TCPConn); ok {
		return t.CloseWrite()
	}
	type cw interface{ CloseWrite() error }
	if x, ok := c.Conn.(cw); ok {
		return x.CloseWrite()
	}
	return c.Close()
}

func (s *Server) serveUDP(e *entry, pc net.PacketConn) {
	if pc == nil {
		return
	}
	buf := make([]byte, 64*1024)
	for {
		n, raddr, err := pc.ReadFrom(buf)
		if err != nil {
			return
		}
		ip := policy.NormalizeIP(raddr.String())
		if e.spec.Mode == "spa" && !s.granted(e.spec.ID) {
			continue
		}
		if !policy.CidrAllowed(ip, e.spec.AllowCidrs) {
			slog.Info("acl drop", "mapping", e.spec.ID, "ip", ip, "proto", "udp")
			continue
		}
		if !e.take(n) {
			continue
		}
		peerKey := raddr.String()
		peerIP := net.ParseIP(ip)
		peerPort := portOf(raddr)
		ready := s.nodeUDPReady(e.nodeID)
		e.mu.Lock()
		sess := e.udpSess[udpPeerIndex(peerKey)]
		idle := time.Duration(policy.IntOr(e.spec.IdleTimeoutSec, 60)) * time.Second
		if sess == nil {
			if !e.reserve() {
				e.mu.Unlock()
				continue
			}
			sess = &udpSess{pc: pc, raddr: raddr, idle: idle, flowID: uplane.NewFlowID(), peerKey: peerKey}
			e.putUDPSess(sess)
		}
		if sess.path == udpPathNone {
			path := udpPathYamux
			if s.udpMode == UDPYamux {
				path = udpPathYamux
			} else if ready {
				path = udpPathUPlane
			} else if s.udpMode == UDPRequired {
				path = udpPathNone
			}
			if path == udpPathNone {
				if e.udpSess[udpFlowIndex(sess.flowID)] == sess {
					e.delUDPSess(sess)
					e.release()
				}
				e.mu.Unlock()
				continue
			}
			sess.path = path
			if path == udpPathUPlane {
				e.udpViaUplane.Store(true)
			} else {
				e.udpViaYamux.Store(true)
			}
		}
		path := sess.path
		flowID := sess.flowID
		sess.touchLocked(e, udpFlowIndex(flowID))
		e.mu.Unlock()

		pkt := uplane.Packet{
			Type: uplane.TypeData, MappingID: e.spec.ID, FlowID: flowID,
			PeerIP: peerIP, PeerPort: peerPort, Payload: append([]byte(nil), buf[:n]...),
		}
		switch path {
		case udpPathUPlane:
			if s.sendNodeUDP(e.nodeID, pkt) {
				e.in.Add(int64(n))
				e.pin.Add(1)
			}
		case udpPathYamux:
			if !s.openUDPFallback(e, sess, udpFlowIndex(flowID), ip, peerPort) {
				continue
			}
			if err := wire.WriteDatagram(sess.st, buf[:n]); err == nil {
				e.in.Add(int64(n))
				e.pin.Add(1)
			}
		}
	}
}

func (s *Server) pickUDPPath(nodeID string) int32 {
	if s.udpMode == UDPYamux {
		return udpPathYamux
	}
	if s.nodeUDPReady(nodeID) {
		return udpPathUPlane
	}
	if s.udpMode == UDPRequired {
		return udpPathNone
	}
	return udpPathYamux
}

func (s *Server) openUDPFallback(e *entry, sess *udpSess, key, ip string, peerPort int) bool {
	if sess.st != nil {
		return true
	}
	s.mu.Lock()
	ac := s.nodes[e.nodeID]
	var ysess *yamux.Session
	if ac != nil && ac.online {
		ysess = ac.sess
	}
	s.mu.Unlock()
	if ysess == nil {
		return false
	}
	st, err := ysess.OpenStream()
	if err != nil {
		return false
	}
	if err := wire.WriteOpen(st, wire.StreamOpen{
		MappingID: e.spec.ID, Proto: "udp", PeerIP: ip, PeerPort: peerPort, Via: e.spec.Mode,
	}); err != nil {
		_ = st.Close()
		return false
	}
	e.mu.Lock()
	if e.udpSess[udpFlowIndex(sess.flowID)] != sess {
		e.mu.Unlock()
		_ = st.Close()
		return false
	}
	sess.st = st
	e.mu.Unlock()
	go s.readUDPStream(e, sess, udpFlowIndex(sess.flowID))
	return true
}

func (s *Server) readUDPStream(e *entry, sess *udpSess, key string) {
	for {
		p, err := wire.ReadDatagram(sess.st)
		if err != nil {
			e.mu.Lock()
			if e.udpSess[key] == sess {
				e.delUDPSess(sess)
				e.release()
				if sess.timer != nil {
					sess.timer.Stop()
				}
			}
			e.mu.Unlock()
			_ = sess.st.Close()
			return
		}
		if _, err := sess.pc.WriteTo(p, sess.raddr); err != nil {
			continue
		}
		e.out.Add(int64(len(p)))
		e.pout.Add(1)
	}
}

func (s *Server) openToNode(nodeID string, o wire.StreamOpen) (net.Conn, *entry, error) {
	s.mu.Lock()
	ac := s.nodes[nodeID]
	e := s.ent[o.MappingID]
	var sess *yamux.Session
	if ac != nil && ac.online {
		sess = ac.sess
	}
	s.mu.Unlock()
	if sess == nil {
		return nil, e, fmt.Errorf("node offline")
	}
	if e == nil {
		return nil, nil, fmt.Errorf("no mapping")
	}
	if !e.reserve() {
		return nil, e, fmt.Errorf("busy")
	}
	st, err := sess.OpenStream()
	if err != nil {
		e.release()
		return nil, e, err
	}
	if err := wire.WriteOpen(st, o); err != nil {
		e.release()
		_ = st.Close()
		return nil, e, err
	}
	return st, e, nil
}

func (s *Server) spliceToNode(e *entry, peer net.Conn, o wire.StreamOpen) {
	st, e2, err := s.openToNode(e.nodeID, o)
	if err != nil {
		_ = peer.Close()
		return
	}
	if e2 != nil {
		e = e2
	}
	defer e.release()
	if !s.reserveSplice() {
		_ = st.Close()
		_ = peer.Close()
		return
	}
	defer s.releaseSplice()
	dst := xfer.WithLimit(st, e.take)
	xfer.CopyBidirectional(dst, peer, &e.in, &e.out)
}

func (s *Server) Probe(mappingID string, payload []byte, timeout time.Duration) ([]byte, error) {
	m, nodeID, ok := s.mappingByID(mappingID)
	if !ok {
		return nil, fmt.Errorf("映射不存在")
	}
	if !m.Enabled {
		return nil, fmt.Errorf("映射已停用")
	}
	st, e, err := s.openToNode(nodeID, wire.StreamOpen{
		MappingID: mappingID, Proto: m.Proto, PeerIP: "127.0.0.1", PeerPort: 0, Via: "probe",
	})
	if err != nil {
		return nil, err
	}
	defer st.Close()
	if e != nil {
		defer e.release()
	}
	_ = st.SetDeadline(time.Now().Add(timeout))
	if m.Proto == "udp" {
		if err := wire.WriteDatagram(st, payload); err != nil {
			return nil, err
		}
		if e != nil {
			e.in.Add(int64(len(payload)))
			e.pin.Add(1)
		}
		reply, err := wire.ReadDatagram(st)
		if err != nil {
			return nil, err
		}
		if e != nil {
			e.out.Add(int64(len(reply)))
			e.pout.Add(1)
		}
		return reply, nil
	}
	if _, err := st.Write(payload); err != nil {
		return nil, err
	}
	if e != nil {
		e.in.Add(int64(len(payload)))
	}
	buf := make([]byte, 256)
	n, err := st.Read(buf)
	if n > 0 && e != nil {
		e.out.Add(int64(n))
	}
	if n == 0 && err != nil {
		return nil, err
	}
	return buf[:n], nil
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

type statusNode struct {
	ID     string `json:"id"`
	Online bool   `json:"online"`
	Addr   string `json:"addr"`
	OS     string `json:"os"`
	Arch   string `json:"arch"`
	Ver    string `json:"version"`
	UPlane bool   `json:"uplane"`
}

type Status struct {
	Nodes   []statusNode `json:"nodes"`
	Stealth string       `json:"stealth"`
	Active  int          `json:"active"`
	UDP     string       `json:"udp"`
}

func (s *Server) Active() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, e := range s.ent {
		n += int(e.active.Load())
	}
	return n
}

func (s *Server) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []statusNode{}
	for _, a := range s.nodes {
		out = append(out, statusNode{ID: a.id, Online: a.online, Addr: a.addr, OS: a.os, Arch: a.arch, Ver: a.ver, UPlane: a.online && a.udpBound && a.udpAddr != nil && a.udpOut != nil && udpSeenFresh(a.udpSeen.Load())})
	}
	n := 0
	for _, e := range s.ent {
		n += int(e.active.Load())
	}
	return Status{Nodes: out, Stealth: s.stealth.Mode(), Active: n, UDP: string(s.udpMode)}
}

type MapStat struct {
	In, Out               int64
	PacketsIn, PacketsOut int64
	Active                int
	NodeID                string
	Error                 string
	Listening             bool
	UDPVia                string
	Generation            int64
	Acked                 bool
}

type PlaneHealth struct {
	Control bool   `json:"control"`
	UPlane  bool   `json:"uplane"`
	UDP     string `json:"udp"`
}

func (s *Server) PlaneHealth() PlaneHealth {
	s.mu.Lock()
	defer s.mu.Unlock()
	return PlaneHealth{
		Control: s.ctrl != nil && !s.draining.Load(),
		UPlane:  s.udpPC != nil,
		UDP:     string(s.udpMode),
	}
}

func (s *Server) MappingStats() map[string]MapStat {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string]MapStat{}
	for id, e := range s.ent {
		listen := e.spec.Mode == "visitor" || e.ln != nil || e.pc != nil
		via := "none"
		yu, up := e.udpViaYamux.Load(), e.udpViaUplane.Load()
		switch {
		case yu && up:
			via = "mixed"
		case up:
			via = "uplane"
		case yu:
			via = "yamux"
		}
		out[id] = MapStat{
			In: e.in.Load(), Out: e.out.Load(),
			PacketsIn: e.pin.Load(), PacketsOut: e.pout.Load(),
			Active: int(e.active.Load()), NodeID: e.nodeID,
			Error: e.listenErr, Listening: listen && e.listenErr == "",
			UDPVia: via, Generation: e.spec.Generation,
			Acked: ackedOK(s.acked[id], e.spec.Generation, s.ackErr[id]),
		}
	}
	return out
}

type Snapshot struct {
	Tokens     map[string]string    `json:"tokens"`
	TokenUntil map[string]int64     `json:"token_until,omitempty"`
	Maps       map[string][]Mapping `json:"maps"`
	Grants     map[string]int64     `json:"grants"`
	Tickets    map[string]int64     `json:"tickets"`
	TicketM    map[string]string    `json:"ticket_maps"`
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
	until := map[string]int64{}
	now := time.Now()
	for k, e := range s.tok {
		if !e.Until.IsZero() && now.After(e.Until) {
			continue
		}
		tok[k] = e.NodeID
		if !e.Until.IsZero() {
			until[k] = e.Until.UnixMilli()
		}
	}
	maps := map[string][]Mapping{}
	for k, v := range s.want {
		maps[k] = v
	}
	tixExp := map[string]int64{}
	tixMap := map[string]string{}
	for h, t := range s.tix {
		if t.Until.IsZero() || t.Until.After(time.Now()) {
			tixMap[h] = t.MappingID
			if !t.Until.IsZero() {
				tixExp[h] = t.Until.UnixMilli()
			}
		}
	}
	return Snapshot{Tokens: tok, TokenUntil: until, Maps: maps, Grants: g, Tickets: tixExp, TicketM: tixMap}
}

func tokenHashOK(s string) bool {
	if len(s) != 64 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}

func (s *Server) RestoreTokens(tokens map[string]string) error {
	return s.restoreTokens(tokens, nil)
}

func (s *Server) restoreTokens(tokens map[string]string, until map[string]int64) error {
	skipped := 0
	now := time.Now()
	for tok, id := range tokens {
		if !tokenHashOK(tok) {
			skipped++
			log.Printf("restore: refusing raw-token snapshot for %s", id)
			continue
		}
		if ms, ok := until[tok]; ok {
			t := time.UnixMilli(ms)
			if !t.After(now) {
				continue
			}
			s.SetTokenHashUntil(tok, id, t)
			delay := time.Until(t)
			if delay < time.Millisecond {
				delay = time.Millisecond
			}
			h := tok
			time.AfterFunc(delay, func() { s.ExpireTokenHash(h) })
			continue
		}
		exp := now.Add(TokenTTL)
		s.SetTokenHashUntil(tok, id, exp)
		h := tok
		time.AfterFunc(TokenTTL, func() { s.ExpireTokenHash(h) })
	}
	if skipped > 0 {
		return fmt.Errorf("refusing raw-token snapshot (%d entries)", skipped)
	}
	return nil
}

func (s *Server) Restore(snap Snapshot) {
	if err := s.restoreTokens(snap.Tokens, snap.TokenUntil); err != nil {
		log.Printf("restore tokens: %v", err)
	}
	for id, maps := range snap.Maps {
		s.PutMappings(id, maps)
	}
	for id, ms := range snap.Grants {
		until := time.UnixMilli(ms)
		if until.After(time.Now()) {
			s.Knock(id, time.Until(until))
		}
	}
	for h, mid := range snap.TicketM {
		until := time.Time{}
		if ms, ok := snap.Tickets[h]; ok {
			until = time.UnixMilli(ms)
		}
		if until.IsZero() || until.After(time.Now()) {
			s.SetTicket(h, mid, until)
		}
	}
}

func (s *Server) StopAccept() {
	if s.ctrl != nil {
		_ = s.ctrl.Close()
	}
	if s.api != nil {
		_ = s.api.Close()
	}
	if s.udpPC != nil {
		_ = s.udpPC.Close()
	}
	s.mu.Lock()
	s.draining.Store(true)
	type pair struct {
		ln net.Listener
		pc net.PacketConn
	}
	conns := []pair{}
	for _, e := range s.ent {
		e.stop()
		conns = append(conns, pair{ln: e.ln, pc: e.pc})
	}
	s.mu.Unlock()
	for _, c := range conns {
		if c.ln != nil {
			_ = c.ln.Close()
		}
		if c.pc != nil {
			_ = c.pc.Close()
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
			NodeID string `json:"node_id"`
		}
		if err := decodeJSONBody(r, &b); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		s.SetToken(r.PathValue("token"), b.NodeID)
		w.WriteHeader(204)
	})
	mux.HandleFunc("PUT /v1/nodes/{id}/mappings", func(w http.ResponseWriter, r *http.Request) {
		var maps []Mapping
		if err := decodeJSONBody(r, &maps); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		s.PutMappings(r.PathValue("id"), maps)
		w.WriteHeader(204)
	})
	mux.HandleFunc("POST /v1/nodes/{id}/revoke", func(w http.ResponseWriter, r *http.Request) {
		s.Revoke(r.PathValue("id"))
		w.WriteHeader(204)
	})
	mux.HandleFunc("POST /v1/nodes/{id}/disconnect", func(w http.ResponseWriter, r *http.Request) {
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

func decodeJSONBody(r *http.Request, v any) error {
	defer r.Body.Close()
	r.Body = http.MaxBytesReader(nil, r.Body, 256<<10)
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
