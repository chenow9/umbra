package control

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"sync"
	"time"

	"golang.org/x/crypto/scrypt"
	"umbra/internal/gate"
	"umbra/internal/wire"
)

type Console struct {
	Gate     *gate.Server
	Listen   string
	CAFile   string
	AgentBin string
	UIDir      string
	UIUpstream string
	SkipAuth   bool
	Persist    string

	mu          sync.Mutex
	ownerHash   string
	ownerSecret string
	agents      map[string]*agentRec
	maps        map[string]*mapRec
	audit       []auditRec
	frames      []frameRec
	samples     []sampleRec
	hits        map[string]hit
	seq         int64
}

type agentRec struct {
	ID, Name, Comment, OS, Arch, Version, Addr, Token, Status string
	Enabled                                                   bool
	Created                                                   time.Time
	LastSeen                                                  *time.Time
}

type mapRec struct {
	Spec         wire.Mapping
	AgentID      string
	ListenState  string
	PushState    string
	ListenError  string
	BytesIn      int64
	BytesOut     int64
	Created      time.Time
	Updated      time.Time
	LastProbe    *time.Time
	LastPreview  string
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
	ID        int64     `json:"id"`
	Ts        time.Time `json:"ts"`
	AgentID   string    `json:"agentId"`
	AgentName string    `json:"agentName"`
	Dir       string    `json:"dir"`
	Type      string    `json:"type"`
	Body      string    `json:"body"`
}

type sampleRec struct {
	Ts   time.Time
	In   int64
	Out  int64
}

type hit struct {
	n int
	t time.Time
}

type persistFile struct {
	OwnerHash   string              `json:"owner_hash"`
	OwnerSecret string              `json:"owner_secret"`
	Agents      []*agentRec         `json:"agents"`
	Maps        []*mapRec           `json:"maps"`
	Audit       []auditRec          `json:"audit"`
}

func New(g *gate.Server, persist string) *Console {
	c := &Console{
		Gate:    g,
		Persist: persist,
		agents:  map[string]*agentRec{},
		maps:    map[string]*mapRec{},
		hits:    map[string]hit{},
	}
	c.load()
	go c.sampleLoop()
	return c
}

func (c *Console) sampleLoop() {
	t := time.NewTicker(10 * time.Second)
	defer t.Stop()
	for range t.C {
		var in, out int64
		st := c.Gate.MappingStats()
		for _, m := range st {
			in += m.In
			out += m.Out
		}
		c.mu.Lock()
		c.samples = append(c.samples, sampleRec{Ts: time.Now(), In: in, Out: out})
		if len(c.samples) > 2000 {
			c.samples = c.samples[len(c.samples)-2000:]
		}
		c.mu.Unlock()
	}
}

func (c *Console) load() {
	raw, err := os.ReadFile(c.Persist)
	if err != nil {
		return
	}
	var p persistFile
	if json.Unmarshal(raw, &p) != nil {
		return
	}
	c.ownerHash, c.ownerSecret = p.OwnerHash, p.OwnerSecret
	for _, a := range p.Agents {
		c.agents[a.ID] = a
		if a.Token != "" && a.Status != "revoked" {
			c.Gate.SetToken(a.Token, a.ID)
		}
	}
	byAgent := map[string][]wire.Mapping{}
	for _, m := range p.Maps {
		c.maps[m.Spec.ID] = m
		byAgent[m.AgentID] = append(byAgent[m.AgentID], m.Spec)
	}
	for id, maps := range byAgent {
		c.Gate.PutMappings(id, maps)
	}
	c.audit = p.Audit
}

func (c *Console) save() {
	p := persistFile{OwnerHash: c.ownerHash, OwnerSecret: c.ownerSecret}
	for _, a := range c.agents {
		cp := *a
		p.Agents = append(p.Agents, &cp)
	}
	for _, m := range c.maps {
		cp := *m
		p.Maps = append(p.Maps, &cp)
	}
	p.Audit = c.audit
	if len(p.Audit) > 200 {
		p.Audit = p.Audit[len(p.Audit)-200:]
	}
	raw, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(c.Persist, raw, 0o600)
}

func newID(prefix string) string {
	var b [6]byte
	_, _ = rand.Read(b[:])
	return fmt.Sprintf("%s_%s%s", prefix, hex.EncodeToString(b[:2]), hex.EncodeToString(b[2:]))
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

func (c *Console) logFrame(agentID, dir, typ, body string) {
	name := ""
	if a := c.agents[agentID]; a != nil {
		name = a.Name
	}
	c.frames = append([]frameRec{{
		ID: c.next(), Ts: time.Now(), AgentID: agentID, AgentName: name, Dir: dir, Type: typ, Body: body,
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
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ownerHash != "" {
		return fmt.Errorf("口令已经设过")
	}
	if len(pw) < 8 || len(pw) > 128 {
		return fmt.Errorf("口令至少 8 位")
	}
	h, err := hashPassword(pw)
	if err != nil {
		return err
	}
	sec := make([]byte, 32)
	_, _ = rand.Read(sec)
	c.ownerHash = h
	c.ownerSecret = hex.EncodeToString(sec)
	c.save()
	return nil
}

func (c *Console) login(pw, ip string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ownerHash == "" {
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
		return fmt.Errorf("试得太勤，过一会儿再来")
	}
	if !checkPassword(pw, c.ownerHash) {
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

func (c *Console) spawnAgent(token string) {
	if c.AgentBin == "" {
		return
	}
	if _, err := os.Stat(c.AgentBin); err != nil {
		return
	}
	args := []string{"--server", c.Listen, "--token", token}
	if c.CAFile != "" {
		args = append(args, "--tls-ca", c.CAFile)
	}
	cmd := exec.Command(c.AgentBin, args...)
	cmd.Stdout = nil
	cmd.Stderr = nil
	_ = cmd.Start()
	if cmd.Process != nil {
		go func() { _, _ = cmd.Process.Wait() }()
	}
}
