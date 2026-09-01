package control

import (
	"bytes"
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

const persistSchema = 1

var errPersist = errors.New("状态未能落盘")

var sessionTTL = 12 * time.Hour

type Console struct {
	Gate       *gate.Server
	Listen     string
	CAFile     string
	NodeBin    string
	UIDir      string
	UIUpstream string
	SkipAuth   bool
	Persist    string
	TrustProxy string

	mu          sync.Mutex
	ownerHash   string
	ownerSecret string
	ownerEpoch  int64
	revoked     map[string]struct{}
	nodes       map[string]*nodeRec
	maps        map[string]*mapRec
	tickets     map[string]*ticketRec
	sessions    map[string]*ownerSess
	audit       []auditRec
	frames      []frameRec
	samples     []sampleRec
	hits        map[string]hit
	seq         int64

	rateIn, rateOut int64
	rateTs          time.Time
	bpsIn, bpsOut   float64
	rateBy          map[string][2]int64
	bpsBy           map[string][2]float64
}

type ownerSess struct {
	Exp  time.Time
	Last time.Time
}

type nodeRec struct {
	ID, Name, Comment, OS, Arch, Version, Addr, Status string
	Token                                              string    `json:"token,omitempty"`
	TokenHash                                          string    `json:"token_hash,omitempty"`
	TokenUntil                                         time.Time `json:"token_until,omitempty"`
	TokenNoExpiry                                      bool      `json:"token_no_expiry,omitempty"`
	PrevHash                                           string    `json:"prev_hash,omitempty"`
	PrevUntil                                          time.Time `json:"prev_until,omitempty"`
	Enabled                                            bool
	Created                                            time.Time
	LastSeen                                           *time.Time
	revealed                                           string
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
	sessIn      int64        `json:"-"`
	sessOut     int64        `json:"-"`
	sessArmed   bool         `json:"-"`
}

func (m *mapRec) absorbStats(in, out int64) (int64, int64) {
	if m == nil {
		return in, out
	}
	if !m.sessArmed {
		m.sessArmed = true
		m.sessIn, m.sessOut = 0, 0
	}
	if in < m.sessIn {
		m.sessIn = 0
	}
	if out < m.sessOut {
		m.sessOut = 0
	}
	if in > m.sessIn {
		m.BytesIn += in - m.sessIn
		m.sessIn = in
	}
	if out > m.sessOut {
		m.BytesOut += out - m.sessOut
		m.sessOut = out
	}
	return m.BytesIn, m.BytesOut
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

type persistSess struct {
	Hash string `json:"hash"`
	Exp  int64  `json:"exp"`
}

type persistFile struct {
	OwnerEpoch  int64         `json:"owner_epoch,omitempty"`
	OwnerHash   string        `json:"owner_hash"`
	OwnerSecret string        `json:"owner_secret"`
	Nodes       []*nodeRec    `json:"nodes"`
	LegacyNodes []*nodeRec    `json:"agents,omitempty"`
	Maps        []*mapRec     `json:"maps"`
	Tickets     []*ticketRec  `json:"tickets"`
	Sessions    []persistSess `json:"sessions,omitempty"`
	Audit       []auditRec    `json:"audit"`
}

type persistBox struct {
	Schema   int             `json:"schema"`
	Checksum string          `json:"checksum"`
	Payload  json.RawMessage `json:"payload"`
}

type persistTomb struct {
	OwnerEpoch  int64    `json:"owner_epoch"`
	OwnerHash   string   `json:"owner_hash"`
	OwnerSecret string   `json:"owner_secret"`
	Revoked     []string `json:"revoked"`
}

func New(g *gate.Server, persist string) (*Console, error) {
	c := &Console{
		Gate:     g,
		Persist:  persist,
		nodes:    map[string]*nodeRec{},
		maps:     map[string]*mapRec{},
		tickets:  map[string]*ticketRec{},
		sessions: map[string]*ownerSess{},
		hits:     map[string]hit{},
		revoked:  map[string]struct{}{},
		rateBy:   map[string][2]int64{},
		bpsBy:    map[string][2]float64{},
	}
	if err := c.load(); err != nil {
		return nil, err
	}
	c.loadTraffic()
	g.SetObserver(c)
	go c.sampleLoop()
	return c, nil
}

func (c *Console) Audit(action, target, detail string) {
	c.mu.Lock()
	c.logAudit(action, target, detail)
	c.mu.Unlock()
}

func (c *Console) Frame(nodeID, dir, typ, body string) {
	c.mu.Lock()
	c.logFrame(nodeID, dir, typ, body)
	c.mu.Unlock()
}

func bumpGeneration(m *wire.Mapping) {
	m.Generation++
	if m.Generation <= 0 {
		m.Generation = 1
	}
}

func (c *Console) sampleLoop() {
	t := time.NewTicker(10 * time.Second)
	defer t.Stop()
	n := 0
	for range t.C {
		live := c.live()
		st := c.Gate.MappingStats()
		now := time.Now()
		c.mu.Lock()
		c.touchOnlineLocked(live, now)
		c.absorbAllLocked(st)
		var in, out int64
		by := map[string][2]int64{}
		for id, rec := range c.maps {
			in += rec.BytesIn
			out += rec.BytesOut
			by[id] = [2]int64{rec.BytesIn, rec.BytesOut}
		}
		c.samples = compactSamples(append(c.samples, sampleRec{Ts: now, In: in, Out: out, By: by}), now)
		n++
		trafficRaw, trafficErr := encodeTrafficFile(c.samples, now)
		saveCtrl := n%6 == 0
		c.mu.Unlock()
		if trafficErr != nil {
			log.Printf("traffic encode: %v", trafficErr)
		} else if p := c.trafficPath(); p != "" {
			if err := writeAtomic(p, trafficRaw, 0o600); err != nil {
				log.Printf("traffic: %v", err)
			}
		}
		if saveCtrl {
			_ = c.save()
		}
	}
}

func persistChecksum(payload []byte) string {
	sum := sha256.Sum256(compactJSON(payload))
	return hex.EncodeToString(sum[:])
}

func compactJSON(raw []byte) []byte {
	var buf bytes.Buffer
	if err := json.Compact(&buf, raw); err != nil {
		return raw
	}
	return buf.Bytes()
}

func decodePersist(raw []byte) (persistFile, error) {
	var p persistFile
	if len(raw) == 0 {
		return p, fmt.Errorf("control.json 损坏，拒绝以空配置启动: empty")
	}
	var box persistBox
	if err := json.Unmarshal(raw, &box); err != nil {
		return p, fmt.Errorf("control.json 损坏，拒绝以空配置启动: %w", err)
	}
	if box.Schema == 0 && len(box.Payload) == 0 && box.Checksum == "" {
		if err := json.Unmarshal(raw, &p); err != nil {
			return p, fmt.Errorf("control.json 损坏，拒绝以空配置启动: %w", err)
		}
		return p, nil
	}
	if box.Schema != persistSchema {
		return p, fmt.Errorf("control.json schema %d 无法识别，拒绝启动", box.Schema)
	}
	payload := compactJSON(box.Payload)
	if box.Checksum == "" || persistChecksum(payload) != box.Checksum {
		return p, fmt.Errorf("control.json 校验和错误，拒绝以空配置启动")
	}
	if err := json.Unmarshal(box.Payload, &p); err != nil {
		return p, fmt.Errorf("control.json 损坏，拒绝以空配置启动: %w", err)
	}
	return p, nil
}

func (c *Console) tombPath() string { return c.Persist + ".tomb" }

func (c *Console) hashRevoked(h string) bool {
	if h == "" || c.revoked == nil {
		return false
	}
	_, ok := c.revoked[h]
	return ok
}

func (c *Console) revokeHash(h string) {
	if h == "" {
		return
	}
	if c.revoked == nil {
		c.revoked = map[string]struct{}{}
	}
	c.revoked[h] = struct{}{}
}

func (c *Console) snapshotRevoked() map[string]struct{} {
	out := make(map[string]struct{}, len(c.revoked))
	for h := range c.revoked {
		out[h] = struct{}{}
	}
	return out
}

func (c *Console) loadTomb() error {
	raw, err := os.ReadFile(c.tombPath())
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	t, err := decodeTomb(raw)
	if err != nil {
		return err
	}
	c.ownerEpoch = t.OwnerEpoch
	if t.OwnerHash != "" {
		c.ownerHash = t.OwnerHash
		c.ownerSecret = t.OwnerSecret
	}
	for _, h := range t.Revoked {
		c.revokeHash(h)
	}
	return nil
}

func decodeTomb(raw []byte) (persistTomb, error) {
	var t persistTomb
	p, err := decodePersistPayload(raw)
	if err != nil {
		return t, fmt.Errorf("control.json.tomb 损坏，拒绝启动: %w", err)
	}
	if err := json.Unmarshal(p, &t); err != nil {
		return t, fmt.Errorf("control.json.tomb 损坏，拒绝启动: %w", err)
	}
	return t, nil
}

func decodePersistPayload(raw []byte) (json.RawMessage, error) {
	var box persistBox
	if err := json.Unmarshal(raw, &box); err != nil {
		return nil, err
	}
	if box.Schema != persistSchema || box.Checksum == "" {
		return nil, fmt.Errorf("schema/checksum")
	}
	payload := compactJSON(box.Payload)
	if persistChecksum(payload) != box.Checksum {
		return nil, fmt.Errorf("checksum")
	}
	return box.Payload, nil
}

func (c *Console) saveTomb() error {
	revoked := make([]string, 0, len(c.revoked))
	for h := range c.revoked {
		if h != "" {
			revoked = append(revoked, h)
		}
	}
	t := persistTomb{
		OwnerEpoch: c.ownerEpoch, OwnerHash: c.ownerHash, OwnerSecret: c.ownerSecret,
		Revoked: revoked,
	}
	payload, err := json.Marshal(t)
	if err != nil {
		return err
	}
	box := persistBox{Schema: persistSchema, Checksum: persistChecksum(payload), Payload: payload}
	raw, err := json.MarshalIndent(box, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(c.tombPath(), raw, 0o600)
}

func (c *Console) load() error {
	if err := c.loadTomb(); err != nil {
		return err
	}
	raw, err := os.ReadFile(c.Persist)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	fromPrev := false
	p, err := decodePersist(raw)
	if err != nil {
		prev, perr := os.ReadFile(c.Persist + ".prev")
		if perr != nil {
			return err
		}
		p, perr = decodePersist(prev)
		if perr != nil {
			return fmt.Errorf("%v; 上一代备份也不可用: %w", err, perr)
		}
		fromPrev = true
		log.Printf("control.json 不可用，已从上一代备份恢复配置；凭证与会话不回滚")
	}
	if c.ownerEpoch > p.OwnerEpoch && c.ownerHash != "" {
		// tomb is newer: keep tomb owner, ignore rolled-back password
	} else {
		c.ownerHash, c.ownerSecret = p.OwnerHash, p.OwnerSecret
		if p.OwnerEpoch > c.ownerEpoch {
			c.ownerEpoch = p.OwnerEpoch
		}
	}
	legacy := p.Nodes
	if len(legacy) == 0 {
		legacy = p.LegacyNodes
	}
	nowLoad := time.Now()
	migratedTTL := false
	for _, a := range legacy {
		if a.Token != "" {
			if a.TokenHash == "" {
				a.TokenHash = gate.TicketHash(a.Token)
			}
			a.Token = ""
		}
		a.revealed = ""
		c.nodes[a.ID] = a
		dead := a.Status == "revoked" || c.hashRevoked(a.TokenHash) || c.hashRevoked(a.PrevHash)
		if dead {
			a.Status = "revoked"
			a.Enabled = false
			a.TokenHash, a.TokenUntil, a.PrevHash, a.PrevUntil, a.revealed = "", time.Time{}, "", time.Time{}, ""
			continue
		}
		if fromPrev {
			a.TokenHash, a.TokenUntil, a.PrevHash, a.PrevUntil, a.revealed = "", time.Time{}, "", time.Time{}, ""
			continue
		}
		if a.TokenHash != "" {
			if a.TokenNoExpiry {
				a.TokenUntil = time.Time{}
				c.installToken(a.TokenHash, a.ID, time.Time{})
			} else {
				until := a.TokenUntil
				if until.IsZero() {
					until = nowLoad.Add(gate.TokenTTL)
					a.TokenUntil = until
					migratedTTL = true
				}
				if until.After(nowLoad) {
					c.installToken(a.TokenHash, a.ID, until)
				} else {
					c.revokeHash(a.TokenHash)
					a.TokenHash = ""
					a.TokenUntil = time.Time{}
				}
			}
		}
		if a.PrevHash != "" && a.PrevUntil.After(nowLoad) && !c.hashRevoked(a.PrevHash) {
			c.Gate.SetTokenHashUntil(a.PrevHash, a.ID, a.PrevUntil)
			h, until := a.PrevHash, a.PrevUntil
			time.AfterFunc(time.Until(until), func() { c.Gate.ExpireTokenHash(h) })
		} else {
			a.PrevHash = ""
			a.PrevUntil = time.Time{}
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
		if m.Spec.Generation <= 0 {
			m.Spec.Generation = 1
		}
		c.maps[m.Spec.ID] = m
		byNode[m.NodeID] = append(byNode[m.NodeID], m.Spec)
	}
	for id, maps := range byNode {
		c.Gate.PutMappings(id, maps)
	}
	c.audit = p.Audit
	now := time.Now()
	if !fromPrev {
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
		for _, s := range p.Sessions {
			if s.Hash == "" {
				continue
			}
			exp := time.Unix(s.Exp, 0)
			if now.After(exp) {
				continue
			}
			c.sessions[s.Hash] = &ownerSess{Exp: exp, Last: now}
		}
	}
	if migratedTTL || fromPrev {
		if err := c.save(); err != nil {
			if fromPrev {
				log.Printf("control.json prev restore persisted without credentials: %v", err)
			} else {
				return err
			}
		}
	}
	return nil
}

func lifetimeUntil(noExpiry bool) time.Time {
	if noExpiry {
		return time.Time{}
	}
	return time.Now().Add(gate.TokenTTL)
}

func (c *Console) installToken(hash, nodeID string, until time.Time) time.Time {
	c.Gate.SetTokenHashUntil(hash, nodeID, until)
	if until.IsZero() {
		return until
	}
	delay := time.Until(until)
	if delay < time.Millisecond {
		delay = time.Millisecond
	}
	h := hash
	time.AfterFunc(delay, func() { c.Gate.ExpireTokenHash(h) })
	return until
}

func (c *Console) save() error {
	if err := c.saveTomb(); err != nil {
		log.Printf("persist tomb: %v", err)
		return fmt.Errorf("%w: %v", errPersist, err)
	}
	p := persistFile{OwnerEpoch: c.ownerEpoch, OwnerHash: c.ownerHash, OwnerSecret: c.ownerSecret}
	for _, a := range c.nodes {
		cp := *a
		cp.Token = ""
		cp.revealed = ""
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
	now := time.Now()
	for h, s := range c.sessions {
		if s == nil || now.After(s.Exp) {
			delete(c.sessions, h)
			continue
		}
		p.Sessions = append(p.Sessions, persistSess{Hash: h, Exp: s.Exp.Unix()})
	}
	p.Audit = c.audit
	if len(p.Audit) > 200 {
		p.Audit = p.Audit[len(p.Audit)-200:]
	}
	payload, err := json.Marshal(p)
	if err != nil {
		log.Printf("persist marshal: %v", err)
		return fmt.Errorf("%w: %v", errPersist, err)
	}
	box := persistBox{Schema: persistSchema, Checksum: persistChecksum(payload), Payload: payload}
	raw, err := json.MarshalIndent(box, "", "  ")
	if err != nil {
		log.Printf("persist marshal: %v", err)
		return fmt.Errorf("%w: %v", errPersist, err)
	}
	if err := backupPrev(c.Persist); err != nil {
		log.Printf("persist prev: %v", err)
		return fmt.Errorf("%w: %v", errPersist, err)
	}
	if err := writeAtomic(c.Persist, raw, 0o600); err != nil {
		log.Printf("persist write: %v", err)
		return fmt.Errorf("%w: %v", errPersist, err)
	}
	return nil
}

func backupPrev(path string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if _, err := decodePersist(raw); err != nil {
		return nil
	}
	return writeAtomic(path+".prev", raw, 0o600)
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
	c.ownerEpoch++
	if err := c.save(); err != nil {
		c.ownerHash = ""
		c.ownerSecret = ""
		c.ownerEpoch--
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
	if h.n >= 8 {
		c.mu.Unlock()
		return fmt.Errorf("试得太勤，过一会儿再来")
	}
	stored := c.ownerHash
	c.mu.Unlock()
	if !checkPassword(pw, stored) {
		c.mu.Lock()
		fail := c.hits[ip]
		if time.Since(fail.t) > 15*time.Minute {
			fail = hit{}
		}
		fail.n++
		fail.t = time.Now()
		c.hits[ip] = fail
		c.mu.Unlock()
		return fmt.Errorf("口令不对")
	}
	c.mu.Lock()
	delete(c.hits, ip)
	c.mu.Unlock()
	return nil
}

func newNodeToken() (plain, hash string) {
	plain = "umbra_boot_" + newID("t")[2:]
	hash = gate.TicketHash(plain)
	return
}

func (c *Console) issueSessionLocked() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	sid := hex.EncodeToString(b[:])
	now := time.Now()
	c.sessions[gate.TicketHash(sid)] = &ownerSess{Exp: now.Add(sessionTTL), Last: now}
	c.pruneSessionsLocked(32)
	return sid
}

func (c *Console) pruneSessionsLocked(max int) {
	for len(c.sessions) > max {
		oldest := ""
		var t time.Time
		for h, s := range c.sessions {
			if s == nil {
				delete(c.sessions, h)
				break
			}
			if oldest == "" || s.Last.Before(t) {
				oldest, t = h, s.Last
			}
		}
		if oldest == "" {
			return
		}
		delete(c.sessions, oldest)
	}
}

func (c *Console) dropSessionLocked(sid string) {
	if sid == "" {
		return
	}
	delete(c.sessions, gate.TicketHash(sid))
}

func (c *Console) dropAllSessionsLocked() {
	c.sessions = map[string]*ownerSess{}
}

func (c *Console) touchSessionLocked(sid string) bool {
	if sid == "" {
		return false
	}
	h := gate.TicketHash(sid)
	s := c.sessions[h]
	now := time.Now()
	if s == nil || now.After(s.Exp) {
		delete(c.sessions, h)
		return false
	}
	s.Last = now
	if time.Until(s.Exp) < sessionTTL/2 {
		s.Exp = now.Add(sessionTTL)
		_ = c.save()
	}
	return true
}

func (c *Console) validCookie(raw string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.touchSessionLocked(raw)
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
