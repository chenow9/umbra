package control

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"golang.org/x/crypto/scrypt"
	"umbra/internal/gate"
	"umbra/internal/wire"
)

var errPersist = errors.New("状态未能落盘")

type Console struct {
	Gate       *gate.Server
	Listen     string
	CAFile     string
	NodeBin    string
	UIDir      string
	UIUpstream string
	SkipAuth   bool
	Persist    string

	mu          sync.Mutex
	ownerHash   string
	ownerSecret string
	nodes       map[string]*nodeRec
	maps        map[string]*mapRec
	tickets     map[string]*ticketRec
	audit       []auditRec
	frames      []frameRec
	samples     []sampleRec
	hits        map[string]hit
	seq         int64
}

type nodeRec struct {
	ID, Name, Comment, OS, Arch, Version, Addr, Token, Status string
	Enabled                                                   bool
	Created                                                   time.Time
	LastSeen                                                  *time.Time
}

type mapRec struct {
	Spec        wire.Mapping `json:"Spec"`
	NodeID      string       `json:"NodeID"`
	LegacyNode  string       `json:"AgentID,omitempty"`
	ListenState string       `json:"ListenState"`
	PushState   string       `json:"PushState"`
	ListenError string       `json:"ListenError"`
	BytesIn     int64        `json:"BytesIn"`
	BytesOut    int64        `json:"BytesOut"`
	Created     time.Time    `json:"Created"`
	Updated     time.Time    `json:"Updated"`
	LastProbe   *time.Time   `json:"LastProbe"`
	LastPreview string       `json:"LastPreview"`
}

type ticketRec struct {
	ID        string    `json:"id"`
	MappingID string    `json:"mapping_id"`
	Hash      string    `json:"hash"`
	Label     string    `json:"label"`
	Expires   time.Time `json:"expires"`
	Created   time.Time `json:"created"`
}

type auditRec struct {
	ID     int64     `json:"id"`
	Ts     time.Time `json:"ts"`
	Actor  string    `json:"actor"`
	Action string    `json:"action"`
	Target string    `json:"target"`
	Detail string    `json:"detail"`
}

type frameRec struct {
	ID       int64     `json:"id"`
	Ts       time.Time `json:"ts"`
	NodeID   string    `json:"nodeId"`
	NodeName string    `json:"nodeName"`
	Dir      string    `json:"dir"`
	Type     string    `json:"type"`
	Body     string    `json:"body"`
}

type sampleRec struct {
	Ts  time.Time
	In  int64
	Out int64
	By  map[string][2]int64
}

type hit struct {
	n int
	t time.Time
}

type persistFile struct {
	OwnerHash   string       `json:"owner_hash"`
	OwnerSecret string       `json:"owner_secret"`
	Nodes       []*nodeRec   `json:"nodes"`
	LegacyNodes []*nodeRec   `json:"agents,omitempty"`
	Maps        []*mapRec    `json:"maps"`
	Tickets     []*ticketRec `json:"tickets"`
	Audit       []auditRec   `json:"audit"`
}

func New(g *gate.Server, persist string) (*Console, error) {
	c := &Console{
		Gate:    g,
		Persist: persist,
		nodes:   map[string]*nodeRec{},
		maps:    map[string]*mapRec{},
		tickets: map[string]*ticketRec{},
		hits:    map[string]hit{},
	}
	if err := c.load(); err != nil {
		return nil, err
	}
	go c.sampleLoop()
	return c, nil
}

func (c *Console) sampleLoop() {
	t := time.NewTicker(10 * time.Second)
	defer t.Stop()
	for range t.C {
		st := c.Gate.MappingStats()
		var in, out int64
		by := map[string][2]int64{}
		for id, m := range st {
			in += m.In
			out += m.Out
			by[id] = [2]int64{m.In, m.Out}
		}
		c.mu.Lock()
		for id, rec := range c.maps {
			if s, ok := st[id]; ok {
				rec.BytesIn, rec.BytesOut = s.In, s.Out
			}
		}
		c.samples = append(c.samples, sampleRec{Ts: time.Now(), In: in, Out: out, By: by})
		if len(c.samples) > 10000 {
			c.samples = c.samples[len(c.samples)-10000:]
		}
		c.mu.Unlock()
	}
}

func (c *Console) load() error {
	raw, err := os.ReadFile(c.Persist)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var p persistFile
	if err := json.Unmarshal(raw, &p); err != nil {
		return fmt.Errorf("control.json 损坏，拒绝以空配置启动: %w", err)
	}
	c.ownerHash, c.ownerSecret = p.OwnerHash, p.OwnerSecret
	legacy := p.Nodes
	if len(legacy) == 0 {
		legacy = p.LegacyNodes
	}
	for _, a := range legacy {
		c.nodes[a.ID] = a
		if a.Token != "" && a.Status != "revoked" {
			c.Gate.SetToken(a.Token, a.ID)
		}
	}
	byNode := map[string][]wire.Mapping{}
	for _, m := range p.Maps {
		if m.NodeID == "" {
			m.NodeID = m.LegacyNode
		}
		m.LegacyNode = ""
		if err := validateMapping(m.Spec.Proto, m.Spec.Mode, m.Spec.EntryPort, m.Spec.LocalHost, m.Spec.LocalPort); err != nil {
			return fmt.Errorf("control.json mapping %s: %w", m.Spec.ID, err)
		}
		if m.Spec.Enabled {
			if err := c.portTaken(m.Spec.ID, m.Spec); err != nil {
				log.Printf("restore: disable %s: %v", m.Spec.ID, err)
				m.Spec.Enabled = false
			}
		}
		c.maps[m.Spec.ID] = m
		byNode[m.NodeID] = append(byNode[m.NodeID], m.Spec)
	}
	for id, maps := range byNode {
		c.Gate.PutMappings(id, maps)
	}
	c.audit = p.Audit
	now := time.Now()
	for _, t := range p.Tickets {
		if t == nil || t.Hash == "" {
			continue
		}
		if !t.Expires.IsZero() && now.After(t.Expires) {
			continue
		}
		c.tickets[t.ID] = t
		c.Gate.SetTicket(t.Hash, t.MappingID, t.Expires)
	}
	return nil
}

func (c *Console) save() error {
	p := persistFile{OwnerHash: c.ownerHash, OwnerSecret: c.ownerSecret}
	for _, a := range c.nodes {
		cp := *a
		p.Nodes = append(p.Nodes, &cp)
	}
	for _, m := range c.maps {
		cp := *m
		p.Maps = append(p.Maps, &cp)
	}
	for _, t := range c.tickets {
		cp := *t
		p.Tickets = append(p.Tickets, &cp)
	}
	p.Audit = c.audit
	if len(p.Audit) > 200 {
		p.Audit = p.Audit[len(p.Audit)-200:]
	}
	raw, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		log.Printf("persist marshal: %v", err)
		return fmt.Errorf("%w: %v", errPersist, err)
	}
	if err := writeAtomic(c.Persist, raw, 0o600); err != nil {
		log.Printf("persist write: %v", err)
		return fmt.Errorf("%w: %v", errPersist, err)
	}
	return nil
}

func writeAtomic(path string, raw []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, "control-*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	if _, err := f.Write(raw); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Chmod(tmp, mode); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return fsyncDir(dir)
}

func fsyncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	if err := d.Sync(); err != nil {
		var errno syscall.Errno
		if errors.As(err, &errno) && errno == syscall.EINVAL {
			return nil
		}
		return err
	}
	return nil
}

func newID(prefix string) string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return fmt.Sprintf("%s_%s", prefix, hex.EncodeToString(b[:]))
}

func (c *Console) next() int64 {
	c.seq++
	return c.seq
}

func (c *Console) logAudit(action, target, detail string) {
	c.audit = append(c.audit, auditRec{
		ID: c.next(), Ts: time.Now(), Actor: "owner", Action: action, Target: target, Detail: detail,
	})
	if len(c.audit) > 200 {
		c.audit = c.audit[len(c.audit)-200:]
	}
}

func (c *Console) logFrame(nodeID, dir, typ, body string) {
	name := ""
	if a := c.nodes[nodeID]; a != nil {
		name = a.Name
	}
	c.frames = append([]frameRec{{
		ID: c.next(), Ts: time.Now(), NodeID: nodeID, NodeName: name, Dir: dir, Type: typ, Body: body,
	}}, c.frames...)
	if len(c.frames) > 40 {
		c.frames = c.frames[:40]
	}
}

func hashPassword(pw string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	dk, err := scrypt.Key([]byte(pw), salt, 16384, 8, 1, 32)
	if err != nil {
		return "", err
	}
	return "scrypt:" + base64.RawURLEncoding.EncodeToString(salt) + ":" + base64.RawURLEncoding.EncodeToString(dk), nil
}

func checkPassword(pw, stored string) bool {
	var kind, sB64, hB64 string
	if _, err := fmt.Sscanf(stored, "%15[^:]:%9999[^:]:%9999s", &kind, &sB64, &hB64); err != nil {
		parts := split3(stored)
		if len(parts) != 3 {
			return false
		}
		kind, sB64, hB64 = parts[0], parts[1], parts[2]
	}
	if kind != "scrypt" {
		return false
	}
	salt, err1 := base64.RawURLEncoding.DecodeString(sB64)
	want, err2 := base64.RawURLEncoding.DecodeString(hB64)
	if err1 != nil || err2 != nil {
		return false
	}
	got, err := scrypt.Key([]byte(pw), salt, 16384, 8, 1, 32)
	if err != nil || len(got) != len(want) {
		return false
	}
	return subtle.ConstantTimeCompare(got, want) == 1
}

func split3(s string) []string {
	out := []string{}
	cur := ""
	for i := 0; i < len(s); i++ {
		if s[i] == ':' && len(out) < 2 {
			out = append(out, cur)
			cur = ""
			continue
		}
		cur += string(s[i])
	}
	out = append(out, cur)
	return out
}

func (c *Console) setup(pw string) error {
	if len(pw) < 8 || len(pw) > 128 {
		return fmt.Errorf("口令至少 8 位")
	}
	c.mu.Lock()
	taken := c.ownerHash != ""
	c.mu.Unlock()
	if taken {
		return fmt.Errorf("口令已经设过")
	}
	h, err := hashPassword(pw)
	if err != nil {
		return err
	}
	sec := make([]byte, 32)
	if _, err := rand.Read(sec); err != nil {
		return err
	}
	secret := hex.EncodeToString(sec)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ownerHash != "" {
		return fmt.Errorf("口令已经设过")
	}
	c.ownerHash = h
	c.ownerSecret = secret
	if err := c.save(); err != nil {
		c.ownerHash = ""
		c.ownerSecret = ""
		return err
	}
	return nil
}

func (c *Console) login(pw, ip string) error {
	c.mu.Lock()
	if c.ownerHash == "" {
		c.mu.Unlock()
		return fmt.Errorf("先设置口令")
	}
	now := time.Now()
	h := c.hits[ip]
	if now.Sub(h.t) > 15*time.Minute {
		h = hit{}
	}
	h.n++
	h.t = now
	c.hits[ip] = h
	if h.n > 8 {
		c.mu.Unlock()
		return fmt.Errorf("试得太勤，过一会儿再来")
	}
	stored := c.ownerHash
	c.mu.Unlock()
	if !checkPassword(pw, stored) {
		return fmt.Errorf("口令不对")
	}
	return nil
}

func (c *Console) cookieValue() string {
	exp := time.Now().Add(7 * 24 * time.Hour).Unix()
	nonce := make([]byte, 8)
	_, _ = rand.Read(nonce)
	payload := fmt.Sprintf("%d:%s", exp, hex.EncodeToString(nonce))
	mac := hmac.New(sha256.New, []byte(c.ownerSecret))
	mac.Write([]byte(payload))
	return payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (c *Console) validCookie(raw string) bool {
	c.mu.Lock()
	sec := c.ownerSecret
	c.mu.Unlock()
	if raw == "" || sec == "" {
		return false
	}
	var payload, sig string
	for i := len(raw) - 1; i >= 0; i-- {
		if raw[i] == '.' {
			payload, sig = raw[:i], raw[i+1:]
			break
		}
	}
	if payload == "" || sig == "" {
		return false
	}
	mac := hmac.New(sha256.New, []byte(sec))
	mac.Write([]byte(payload))
	want := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if subtle.ConstantTimeCompare([]byte(sig), []byte(want)) != 1 {
		return false
	}
	var exp int64
	fmt.Sscanf(payload, "%d:", &exp)
	return time.Now().Unix() < exp
}

func (c *Console) authStatus(cookie string) map[string]bool {
	if c.SkipAuth {
		return map[string]bool{"required": false, "configured": true, "signedIn": true}
	}
	c.mu.Lock()
	cfg := c.ownerHash != ""
	c.mu.Unlock()
	return map[string]bool{"required": true, "configured": cfg, "signedIn": cfg && c.validCookie(cookie)}
}

func (c *Console) spawnNode(token string) {
	if c.NodeBin == "" {
		return
	}
	if _, err := os.Stat(c.NodeBin); err != nil {
		return
	}
	args := []string{"--server", c.Listen, "--token", token}
	if c.CAFile != "" {
		args = append(args, "--tls-ca", c.CAFile)
	}
	cmd := exec.Command(c.NodeBin, args...)
	cmd.Stdout = nil
	cmd.Stderr = nil
	_ = cmd.Start()
	if cmd.Process != nil {
		go func() { _, _ = cmd.Process.Wait() }()
	}
}
