package control

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"
	"unicode"

	"umbra/internal/gate"
	"umbra/internal/policy"
	"umbra/internal/wire"
)

const (
	configBundleKind  = "umbra.config-bundle"
	configSchemaV1    = 1
	importJSONLimit   = 1 << 20
	maxImportNodes    = 50
	maxImportServices = 500
	maxNameLen        = 200
	maxCommentLen     = 1000
	maxCidrLen        = 4096
	maxOriginIDLen    = 128
)

var errImportConflict = errors.New("导入存在冲突")

var forbiddenBundleKeys = map[string]struct{}{
	"token": {}, "tokenhash": {}, "revealed": {}, "ticket": {}, "tickets": {},
	"ownerhash": {}, "ownersecret": {}, "password": {}, "secret": {},
	"recovery": {}, "recoverycode": {}, "recoverycodes": {}, "privatekey": {},
	"bootstrap": {}, "bootstraphash": {}, "credfp": {}, "session": {}, "sessions": {},
	"pendingsecret": {}, "totp": {},
}

type importNodeOrigin struct {
	SourceID string `json:"source_id"`
	OriginID string `json:"origin_id"`
	LocalID  string `json:"local_id"`
}

type importMapOrigin struct {
	SourceID    string `json:"source_id"`
	OriginID    string `json:"origin_id"`
	LocalNodeID string `json:"local_node_id"`
	LocalID     string `json:"local_id"`
}

type ConfigBundle struct {
	SchemaVersion int             `json:"schemaVersion"`
	Kind          string          `json:"kind"`
	SourceID      string          `json:"sourceId"`
	ExportedAt    string          `json:"exportedAt"`
	Nodes         []ExportNode    `json:"nodes"`
	Services      []ExportService `json:"services"`
}

type ExportNode struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Comment string `json:"comment,omitempty"`
	OS      string `json:"os,omitempty"`
	Arch    string `json:"arch,omitempty"`
}

type ExportService struct {
	ID                string `json:"id"`
	NodeID            string `json:"nodeId"`
	Name              string `json:"name"`
	Proto             string `json:"proto"`
	Mode              string `json:"mode"`
	EntryPort         *int   `json:"entryPort"`
	LocalHost         string `json:"localHost"`
	LocalPort         int    `json:"localPort"`
	Enabled           bool   `json:"enabled"`
	MaxConns          int    `json:"maxConns"`
	RateKbps          int    `json:"rateKbps"`
	AllowCidrs        string `json:"allowCidrs"`
	IdleTimeoutSec    int    `json:"idleTimeoutSec"`
	SpaTTLSec         int    `json:"spaTtlSec"`
	UdpIdleTimeoutSec int    `json:"udpIdleTimeoutSec"`
}

type exportNodeSel struct {
	ID         string    `json:"id"`
	ServiceIDs *[]string `json:"serviceIds"`
}

type importBinding struct {
	OriginNodeID string             `json:"originNodeId"`
	Action       string             `json:"action"`
	LocalNodeID  string             `json:"localNodeId,omitempty"`
	Name         string             `json:"name,omitempty"`
	Comment      string             `json:"comment,omitempty"`
	OS           string             `json:"os,omitempty"`
	Arch         string             `json:"arch,omitempty"`
	NeverExpire  bool               `json:"neverExpire,omitempty"`
	Services     []importServiceSel `json:"services"`
}

type importServiceSel struct {
	OriginID string `json:"originId"`
	Action   string `json:"action"`
}

type importRequest struct {
	Bundle   ConfigBundle    `json:"bundle"`
	Bindings []importBinding `json:"bindings"`
}

type previewDiff struct {
	Field string `json:"field"`
	From  any    `json:"from"`
	To    any    `json:"to"`
}

type previewLocalNode struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Status       string `json:"status"`
	Enabled      bool   `json:"enabled"`
	MappingCount int    `json:"mappingCount"`
}

type previewService struct {
	OriginID       string        `json:"originId"`
	Name           string        `json:"name"`
	Proto          string        `json:"proto"`
	Mode           string        `json:"mode"`
	EntryPort      *int          `json:"entryPort"`
	LocalHost      string        `json:"localHost"`
	LocalPort      int           `json:"localPort"`
	Enabled        bool          `json:"enabled"`
	Action         string        `json:"action,omitempty"`
	MatchedLocalID string        `json:"matchedLocalId,omitempty"`
	Reason         string        `json:"reason,omitempty"`
	Error          bool          `json:"error,omitempty"`
	Diff           []previewDiff `json:"diff,omitempty"`
}

type previewNode struct {
	OriginID             string           `json:"originId"`
	Name                 string           `json:"name"`
	Comment              string           `json:"comment"`
	OS                   string           `json:"os"`
	Arch                 string           `json:"arch"`
	Action               string           `json:"action,omitempty"`
	LocalNodeID          string           `json:"localNodeId,omitempty"`
	LocalNodeName        string           `json:"localNodeName,omitempty"`
	PreviousLocalNodeIDs []string         `json:"previousLocalNodeIds,omitempty"`
	Reason               string           `json:"reason,omitempty"`
	Error                bool             `json:"error,omitempty"`
	Services             []previewService `json:"services"`
}

type previewSummary struct {
	NodesCreate    int `json:"nodesCreate"`
	NodesBind      int `json:"nodesBind"`
	ServicesCreate int `json:"servicesCreate"`
	ServicesUpdate int `json:"servicesUpdate"`
	ServicesSkip   int `json:"servicesSkip"`
	Conflicts      int `json:"conflicts"`
}

type importPreview struct {
	Valid      bool               `json:"valid"`
	CanApply   bool               `json:"canApply"`
	Errors     []string           `json:"errors,omitempty"`
	SourceID   string             `json:"sourceId"`
	ExportedAt string             `json:"exportedAt"`
	LocalNodes []previewLocalNode `json:"localNodes"`
	Nodes      []previewNode      `json:"nodes"`
	Summary    previewSummary     `json:"summary"`
}

type importNodeResult struct {
	OriginID    string `json:"originId"`
	LocalID     string `json:"localId"`
	Action      string `json:"action"`
	Name        string `json:"name"`
	Token       string `json:"token,omitempty"`
	OS          string `json:"os,omitempty"`
	Arch        string `json:"arch,omitempty"`
	InstallCmd  string `json:"installCmd,omitempty"`
	DockerCmd   string `json:"dockerCmd,omitempty"`
	Listen      string `json:"listen,omitempty"`
	CAPem       string `json:"caPem,omitempty"`
	ExpiresAt   string `json:"expiresAt,omitempty"`
	NeverExpire bool   `json:"neverExpire,omitempty"`
}

type importServiceResult struct {
	OriginID    string `json:"originId"`
	LocalID     string `json:"localId,omitempty"`
	Name        string `json:"name"`
	Action      string `json:"action"`
	Result      string `json:"result"`
	PushState   string `json:"pushState,omitempty"`
	ListenState string `json:"listenState,omitempty"`
	ListenError string `json:"listenError,omitempty"`
}

type importResult struct {
	Saved    bool                  `json:"saved"`
	Nodes    []importNodeResult    `json:"nodes"`
	Services []importServiceResult `json:"services"`
	Summary  previewSummary        `json:"summary"`
}

type plannedService struct {
	originID    string
	originNode  string
	action      string
	localID     string
	localNodeID string
	spec        wire.Mapping
	view        previewService
}

type plannedNode struct {
	originID    string
	action      string
	localID     string
	name        string
	comment     string
	os          string
	arch        string
	neverExpire bool
	view        previewNode
	services    []plannedService
}

type importPlan struct {
	canApply bool
	errors   []string
	nodes    []plannedNode
	summary  previewSummary
}

type configSnap struct {
	nodes       map[string]*nodeRec
	maps        map[string]*mapRec
	nodeOrigins []importNodeOrigin
	mapOrigins  []importMapOrigin
	audit       []auditRec
	seq         int64
	instanceID  string
}

func (c *Console) ensureInstanceIDLocked() error {
	if c.instanceID != "" {
		return nil
	}
	id, err := newID("src")
	if err != nil {
		return err
	}
	c.instanceID = id
	return nil
}

func (c *Console) exportBundleLocked(sel []exportNodeSel) (*ConfigBundle, error) {
	if len(sel) == 0 {
		return nil, fmt.Errorf("请选择要导出的节点")
	}
	if len(sel) > maxImportNodes {
		return nil, fmt.Errorf("一次最多导出 %d 个节点", maxImportNodes)
	}
	if err := c.ensureInstanceIDLocked(); err != nil {
		return nil, err
	}
	seenNode := map[string]struct{}{}
	nodes := make([]ExportNode, 0, len(sel))
	services := make([]ExportService, 0)
	for _, item := range sel {
		id := strings.TrimSpace(item.ID)
		if id == "" {
			return nil, fmt.Errorf("需要节点")
		}
		if _, dup := seenNode[id]; dup {
			return nil, fmt.Errorf("节点重复")
		}
		seenNode[id] = struct{}{}
		n := c.nodes[id]
		if n == nil {
			return nil, fmt.Errorf("节点不存在")
		}
		nodes = append(nodes, ExportNode{
			ID: n.ID, Name: n.Name, Comment: n.Comment, OS: n.OS, Arch: n.Arch,
		})
		owned := map[string]*mapRec{}
		for _, m := range c.maps {
			if m.NodeID == id {
				owned[m.Spec.ID] = m
			}
		}
		var want []string
		if item.ServiceIDs == nil {
			for mid := range owned {
				want = append(want, mid)
			}
		} else {
			want = *item.ServiceIDs
		}
		if len(services)+len(want) > maxImportServices {
			return nil, fmt.Errorf("一次最多导出 %d 项服务", maxImportServices)
		}
		seenSvc := map[string]struct{}{}
		for _, mid := range want {
			mid = strings.TrimSpace(mid)
			if mid == "" {
				return nil, fmt.Errorf("服务标识无效")
			}
			if _, dup := seenSvc[mid]; dup {
				return nil, fmt.Errorf("服务重复")
			}
			seenSvc[mid] = struct{}{}
			m := owned[mid]
			if m == nil {
				return nil, fmt.Errorf("服务不属于所选节点")
			}
			services = append(services, exportService(m))
		}
	}
	c.logAudit("config.export", c.instanceID, fmt.Sprintf("%d 个节点，%d 项服务", len(nodes), len(services)))
	return &ConfigBundle{
		SchemaVersion: configSchemaV1,
		Kind:          configBundleKind,
		SourceID:      c.instanceID,
		ExportedAt:    time.Now().UTC().Format(time.RFC3339),
		Nodes:         nodes,
		Services:      services,
	}, nil
}

func exportService(m *mapRec) ExportService {
	port := copyPort(m.Spec.EntryPort)
	if m.Spec.Mode == "visitor" {
		port = nil
	}
	return ExportService{
		ID: m.Spec.ID, NodeID: m.NodeID, Name: m.Spec.Name,
		Proto: m.Spec.Proto, Mode: m.Spec.Mode, EntryPort: port,
		LocalHost: m.Spec.LocalHost, LocalPort: m.Spec.LocalPort, Enabled: m.Spec.Enabled,
		MaxConns:          policy.MaxConns(m.Spec.MaxConns),
		RateKbps:          m.Spec.RateKbps,
		AllowCidrs:        m.Spec.AllowCidrs,
		IdleTimeoutSec:    m.Spec.IdleTimeoutSec,
		SpaTTLSec:         policy.ClampTimeoutSec(m.Spec.SpaTTLSec, policy.DefaultSPATimeoutSec),
		UdpIdleTimeoutSec: policy.ClampTimeoutSec(m.Spec.UdpIdleTimeoutSec, policy.DefaultUDPIdleSec),
	}
}

func inspectImportPayload(raw []byte) error {
	var top map[string]any
	if err := json.Unmarshal(raw, &top); err != nil {
		return fmt.Errorf("不是有效的 JSON")
	}
	bundle, ok := top["bundle"]
	if !ok {
		return fmt.Errorf("缺少配置包")
	}
	if m, ok := bundle.(map[string]any); ok {
		if _, hasSum := m["checksum"]; hasSum {
			if _, hasPayload := m["payload"]; hasPayload {
				return fmt.Errorf("不是可导入的配置包")
			}
		}
	}
	return walkForbidden(bundle)
}

func walkForbidden(v any) error {
	switch t := v.(type) {
	case map[string]any:
		for k, child := range t {
			nk := normalizeJSONKey(k)
			if _, bad := forbiddenBundleKeys[nk]; bad {
				return fmt.Errorf("配置包含敏感字段")
			}
			if err := walkForbidden(child); err != nil {
				return err
			}
		}
	case []any:
		for _, child := range t {
			if err := walkForbidden(child); err != nil {
				return err
			}
		}
	}
	return nil
}

func normalizeJSONKey(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if r == '_' || r == '-' {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

func validateBundle(b *ConfigBundle) error {
	if b.SchemaVersion != configSchemaV1 {
		return fmt.Errorf("不支持的配置格式版本")
	}
	if b.Kind != "" && b.Kind != configBundleKind {
		return fmt.Errorf("不是可导入的配置包")
	}
	if !validOriginID(b.SourceID) {
		return fmt.Errorf("缺少来源标识")
	}
	if len(b.Nodes) == 0 {
		return fmt.Errorf("配置包没有节点")
	}
	if len(b.Nodes) > maxImportNodes {
		return fmt.Errorf("一次最多导入 %d 个节点", maxImportNodes)
	}
	if len(b.Services) > maxImportServices {
		return fmt.Errorf("一次最多导入 %d 项服务", maxImportServices)
	}
	nodes := map[string]struct{}{}
	for i := range b.Nodes {
		n := &b.Nodes[i]
		n.ID = strings.TrimSpace(n.ID)
		n.Name = strings.TrimSpace(n.Name)
		n.Comment = strings.TrimSpace(n.Comment)
		n.OS = strings.TrimSpace(n.OS)
		n.Arch = strings.TrimSpace(n.Arch)
		if !validOriginID(n.ID) {
			return fmt.Errorf("节点标识无效")
		}
		if _, dup := nodes[n.ID]; dup {
			return fmt.Errorf("节点标识重复")
		}
		nodes[n.ID] = struct{}{}
		if err := checkNameComment(n.Name, n.Comment); err != nil {
			return err
		}
	}
	svcs := map[string]struct{}{}
	for i := range b.Services {
		s := &b.Services[i]
		s.ID = strings.TrimSpace(s.ID)
		s.NodeID = strings.TrimSpace(s.NodeID)
		s.Name = strings.TrimSpace(s.Name)
		s.Proto = strings.ToLower(strings.TrimSpace(s.Proto))
		s.Mode = strings.ToLower(strings.TrimSpace(s.Mode))
		s.LocalHost = strings.TrimSpace(s.LocalHost)
		s.AllowCidrs = strings.TrimSpace(s.AllowCidrs)
		if !validOriginID(s.ID) {
			return fmt.Errorf("服务标识无效")
		}
		if _, dup := svcs[s.ID]; dup {
			return fmt.Errorf("服务标识重复")
		}
		svcs[s.ID] = struct{}{}
		if _, ok := nodes[s.NodeID]; !ok {
			return fmt.Errorf("服务引用了未知节点")
		}
		if err := checkNameComment(s.Name, ""); err != nil {
			return err
		}
		if _, err := specFromExport(*s); err != nil {
			return err
		}
	}
	return nil
}

func checkNameComment(name, comment string) error {
	if name == "" {
		return fmt.Errorf("需要名称")
	}
	if len([]rune(name)) > maxNameLen {
		return fmt.Errorf("名称过长")
	}
	if len([]rune(comment)) > maxCommentLen {
		return fmt.Errorf("备注过长")
	}
	if strings.ContainsRune(name, 0) || strings.ContainsRune(comment, 0) {
		return fmt.Errorf("名称无效")
	}
	return nil
}

func validOriginID(id string) bool {
	if id == "" || len(id) > maxOriginIDLen {
		return false
	}
	for _, r := range id {
		if r > unicode.MaxASCII || !(unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' || r == '-') {
			return false
		}
	}
	return true
}

func specFromExport(s ExportService) (wire.Mapping, error) {
	port := copyPort(s.EntryPort)
	if s.Mode == "visitor" {
		if s.EntryPort != nil {
			return wire.Mapping{}, fmt.Errorf("访问端不能占用入口端口")
		}
		port = nil
	}
	if err := validateMapping(s.Proto, s.Mode, port, s.LocalHost, s.LocalPort); err != nil {
		return wire.Mapping{}, err
	}
	if err := validateCidrs(s.AllowCidrs); err != nil {
		return wire.Mapping{}, err
	}
	if len(s.AllowCidrs) > maxCidrLen {
		return wire.Mapping{}, fmt.Errorf("白名单过长")
	}
	if s.IdleTimeoutSec < 0 {
		return wire.Mapping{}, fmt.Errorf("超时无效")
	}
	if s.SpaTTLSec < 0 || s.SpaTTLSec > policy.MaxTimeoutSec {
		return wire.Mapping{}, fmt.Errorf("敲门有效期无效")
	}
	if s.UdpIdleTimeoutSec < 0 || s.UdpIdleTimeoutSec > policy.MaxTimeoutSec {
		return wire.Mapping{}, fmt.Errorf("UDP 空闲超时无效")
	}
	return wire.Mapping{
		Name: s.Name, Proto: s.Proto, Mode: s.Mode, EntryPort: port,
		LocalHost: s.LocalHost, LocalPort: s.LocalPort, Enabled: s.Enabled,
		MaxConns:          policy.MaxConns(s.MaxConns),
		RateKbps:          s.RateKbps,
		AllowCidrs:        s.AllowCidrs,
		IdleTimeoutSec:    s.IdleTimeoutSec,
		SpaTTLSec:         policy.ClampTimeoutSec(s.SpaTTLSec, policy.DefaultSPATimeoutSec),
		UdpIdleTimeoutSec: policy.ClampTimeoutSec(s.UdpIdleTimeoutSec, policy.DefaultUDPIdleSec),
	}, nil
}

func validateCidrs(s string) error {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	parts := strings.FieldsFunc(s, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\n' || r == '\t' || r == '\r'
	})
	if len(parts) == 0 {
		return nil
	}
	for _, p := range parts {
		if strings.Contains(p, "/") {
			if _, _, err := net.ParseCIDR(p); err != nil {
				return fmt.Errorf("白名单网段无效")
			}
			continue
		}
		if net.ParseIP(p) == nil {
			return fmt.Errorf("白名单网段无效")
		}
	}
	return nil
}

func copyPort(p *int) *int {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}

func (c *Console) localNodeCatalogLocked(live map[string]gateNode) []previewLocalNode {
	out := make([]previewLocalNode, 0, len(c.nodes))
	for _, n := range c.sortedNodes() {
		st, _, _, _, _ := nodeRuntime(n, live)
		count := 0
		for _, m := range c.maps {
			if m.NodeID == n.ID {
				count++
			}
		}
		out = append(out, previewLocalNode{
			ID: n.ID, Name: n.Name, Status: st,
			Enabled: n.Enabled && n.Status != "revoked", MappingCount: count,
		})
	}
	return out
}

func (c *Console) previousLocalsLocked(sourceID, originNodeID string) []string {
	var ids []string
	seen := map[string]struct{}{}
	for _, o := range c.nodeOrigins {
		if o.SourceID != sourceID || o.OriginID != originNodeID {
			continue
		}
		if c.nodes[o.LocalID] == nil {
			continue
		}
		if _, ok := seen[o.LocalID]; ok {
			continue
		}
		seen[o.LocalID] = struct{}{}
		ids = append(ids, o.LocalID)
	}
	return ids
}

func (c *Console) findMapOriginLocked(sourceID, originID, localNodeID string) (importMapOrigin, bool) {
	for _, o := range c.mapOrigins {
		if o.SourceID == sourceID && o.OriginID == originID && o.LocalNodeID == localNodeID {
			if c.maps[o.LocalID] != nil && c.maps[o.LocalID].NodeID == localNodeID {
				return o, true
			}
		}
	}
	return importMapOrigin{}, false
}

func (c *Console) upsertNodeOriginLocked(sourceID, originID, localID string) {
	for i, o := range c.nodeOrigins {
		if o.SourceID == sourceID && o.OriginID == originID && o.LocalID == localID {
			c.nodeOrigins[i] = importNodeOrigin{SourceID: sourceID, OriginID: originID, LocalID: localID}
			return
		}
	}
	c.nodeOrigins = append(c.nodeOrigins, importNodeOrigin{SourceID: sourceID, OriginID: originID, LocalID: localID})
}

func (c *Console) upsertMapOriginLocked(sourceID, originID, localNodeID, localID string) {
	for i, o := range c.mapOrigins {
		if o.SourceID == sourceID && o.OriginID == originID && o.LocalNodeID == localNodeID {
			c.mapOrigins[i] = importMapOrigin{SourceID: sourceID, OriginID: originID, LocalNodeID: localNodeID, LocalID: localID}
			return
		}
	}
	c.mapOrigins = append(c.mapOrigins, importMapOrigin{SourceID: sourceID, OriginID: originID, LocalNodeID: localNodeID, LocalID: localID})
}

func (c *Console) pruneOriginsForNodeLocked(id string) {
	nodeOut := c.nodeOrigins[:0]
	for _, o := range c.nodeOrigins {
		if o.LocalID != id {
			nodeOut = append(nodeOut, o)
		}
	}
	c.nodeOrigins = nodeOut
	mapOut := c.mapOrigins[:0]
	for _, o := range c.mapOrigins {
		if o.LocalNodeID != id {
			mapOut = append(mapOut, o)
		}
	}
	c.mapOrigins = mapOut
}

func (c *Console) pruneOriginsForMapLocked(id string) {
	out := c.mapOrigins[:0]
	for _, o := range c.mapOrigins {
		if o.LocalID != id {
			out = append(out, o)
		}
	}
	c.mapOrigins = out
}

func (c *Console) pruneDanglingOriginsLocked() {
	nodeOut := c.nodeOrigins[:0]
	for _, o := range c.nodeOrigins {
		if c.nodes[o.LocalID] != nil {
			nodeOut = append(nodeOut, o)
		}
	}
	c.nodeOrigins = nodeOut
	mapOut := c.mapOrigins[:0]
	for _, o := range c.mapOrigins {
		m := c.maps[o.LocalID]
		if m != nil && m.NodeID == o.LocalNodeID && c.nodes[o.LocalNodeID] != nil {
			mapOut = append(mapOut, o)
		}
	}
	c.mapOrigins = mapOut
}

func bundleServicesByNode(b ConfigBundle) map[string][]ExportService {
	out := map[string][]ExportService{}
	for _, s := range b.Services {
		out[s.NodeID] = append(out[s.NodeID], s)
	}
	return out
}

func (c *Console) previewImportLocked(bundle ConfigBundle, bindings []importBinding, live map[string]gateNode) importPreview {
	out := importPreview{
		Valid:      true,
		SourceID:   bundle.SourceID,
		ExportedAt: bundle.ExportedAt,
		LocalNodes: c.localNodeCatalogLocked(live),
		Nodes:      make([]previewNode, 0, len(bundle.Nodes)),
	}
	byNode := bundleServicesByNode(bundle)
	if len(bindings) == 0 {
		for _, n := range bundle.Nodes {
			svcs := make([]previewService, 0, len(byNode[n.ID]))
			for _, s := range byNode[n.ID] {
				svcs = append(svcs, catalogService(s))
			}
			out.Nodes = append(out.Nodes, previewNode{
				OriginID:             n.ID,
				Name:                 n.Name,
				Comment:              n.Comment,
				OS:                   n.OS,
				Arch:                 n.Arch,
				PreviousLocalNodeIDs: c.previousLocalsLocked(bundle.SourceID, n.ID),
				Services:             svcs,
			})
		}
		return out
	}
	plan := c.buildPlanLocked(bundle, bindings)
	out.CanApply = plan.canApply
	out.Errors = plan.errors
	out.Summary = plan.summary
	for _, n := range plan.nodes {
		out.Nodes = append(out.Nodes, n.view)
	}
	return out
}

func catalogService(s ExportService) previewService {
	return previewService{
		OriginID: s.ID, Name: s.Name, Proto: s.Proto, Mode: s.Mode,
		EntryPort: copyPort(s.EntryPort), LocalHost: s.LocalHost, LocalPort: s.LocalPort, Enabled: s.Enabled,
	}
}

func (c *Console) buildPlanLocked(bundle ConfigBundle, bindings []importBinding) importPlan {
	plan := importPlan{canApply: true}
	byNode := bundleServicesByNode(bundle)
	originNodes := map[string]ExportNode{}
	for _, n := range bundle.Nodes {
		originNodes[n.ID] = n
	}
	seenBind := map[string]struct{}{}
	if len(bindings) == 0 {
		plan.canApply = false
		plan.errors = append(plan.errors, "请为每个来源节点选择新建或绑定")
		return plan
	}
	var planned []wire.Mapping
	ignore := map[string]struct{}{}

	for _, b := range bindings {
		originID := strings.TrimSpace(b.OriginNodeID)
		src, ok := originNodes[originID]
		if !ok {
			plan.canApply = false
			plan.errors = append(plan.errors, "绑定引用了未知节点")
			continue
		}
		if _, dup := seenBind[originID]; dup {
			plan.canApply = false
			plan.errors = append(plan.errors, "来源节点重复绑定")
			continue
		}
		seenBind[originID] = struct{}{}
		pn := plannedNode{
			originID:    originID,
			action:      strings.TrimSpace(b.Action),
			name:        strings.TrimSpace(firstNonEmpty(b.Name, src.Name)),
			comment:     strings.TrimSpace(firstNonEmpty(b.Comment, src.Comment)),
			os:          firstNonEmpty(strings.TrimSpace(b.OS), src.OS),
			arch:        firstNonEmpty(strings.TrimSpace(b.Arch), src.Arch),
			neverExpire: b.NeverExpire,
		}
		pn.view = previewNode{
			OriginID:             src.ID,
			Name:                 pn.name,
			Comment:              pn.comment,
			OS:                   pn.os,
			Arch:                 pn.arch,
			Action:               pn.action,
			PreviousLocalNodeIDs: c.previousLocalsLocked(bundle.SourceID, originID),
			Services:             []previewService{},
		}
		switch pn.action {
		case "create":
			if err := checkNameComment(pn.name, pn.comment); err != nil {
				pn.view.Error = true
				pn.view.Reason = err.Error()
				plan.canApply = false
			} else {
				plan.summary.NodesCreate++
			}
		case "bind":
			localID := strings.TrimSpace(b.LocalNodeID)
			node := c.nodes[localID]
			if node == nil {
				pn.view.Error = true
				pn.view.Reason = "节点不存在"
				plan.canApply = false
			} else if node.Status == "revoked" || !node.Enabled {
				pn.view.Error = true
				pn.view.Reason = "节点已吊销"
				plan.canApply = false
			} else {
				pn.localID = localID
				pn.view.LocalNodeID = localID
				pn.view.LocalNodeName = node.Name
				plan.summary.NodesBind++
			}
		default:
			pn.view.Error = true
			pn.view.Reason = "请选择新建节点或绑定已有节点"
			plan.canApply = false
		}

		want := map[string]string{}
		for _, s := range b.Services {
			oid := strings.TrimSpace(s.OriginID)
			if oid == "" {
				continue
			}
			want[oid] = strings.TrimSpace(s.Action)
		}
		have := map[string]struct{}{}
		for _, s := range byNode[originID] {
			have[s.ID] = struct{}{}
			ps := c.planServiceLocked(bundle.SourceID, pn, s, want[s.ID])
			if ps.view.Error {
				plan.canApply = false
				plan.summary.Conflicts++
			}
			switch ps.action {
			case "create":
				plan.summary.ServicesCreate++
				planned = append(planned, ps.spec)
			case "update":
				plan.summary.ServicesUpdate++
				if ps.localID != "" {
					ignore[ps.localID] = struct{}{}
				}
				spec := ps.spec
				spec.ID = ps.localID
				planned = append(planned, spec)
			case "skip":
				plan.summary.ServicesSkip++
			}
			pn.services = append(pn.services, ps)
			pn.view.Services = append(pn.view.Services, ps.view)
		}
		for oid := range want {
			if _, ok := have[oid]; !ok {
				plan.canApply = false
				plan.errors = append(plan.errors, "绑定引用了未知服务")
			}
		}
		plan.nodes = append(plan.nodes, pn)
	}

	if err := c.portsConflictLocked(planned, ignore); err != nil {
		plan.canApply = false
		plan.errors = append(plan.errors, err.Error())
		markPortConflicts(&plan, err)
	}
	if !plan.canApply && len(plan.errors) == 0 {
		for _, n := range plan.nodes {
			if n.view.Error && n.view.Reason != "" {
				plan.errors = append(plan.errors, n.view.Reason)
			}
			for _, s := range n.view.Services {
				if s.Error && s.Reason != "" {
					plan.errors = append(plan.errors, s.Reason)
				}
			}
		}
	}
	return plan
}

type portConflictError struct {
	proto string
	port  int
}

func (e portConflictError) Error() string {
	return fmt.Sprintf("端口 %s/%d 已被映射占用", e.proto, e.port)
}

func markPortConflicts(plan *importPlan, err error) {
	reason := err.Error()
	var pe portConflictError
	_ = errors.As(err, &pe)
	for i := range plan.nodes {
		for j := range plan.nodes[i].services {
			ps := &plan.nodes[i].services[j]
			if ps.action != "create" && ps.action != "update" {
				continue
			}
			key, ok := listenKey(ps.spec)
			if !ok {
				continue
			}
			if pe.port != 0 {
				want := fmt.Sprintf("%s/%d", pe.proto, pe.port)
				if key != want {
					continue
				}
			}
			if !ps.view.Error {
				ps.view.Error = true
				ps.view.Reason = reason
				plan.summary.Conflicts++
				plan.nodes[i].view.Services[j] = ps.view
			}
		}
	}
}

func (c *Console) planServiceLocked(sourceID string, node plannedNode, s ExportService, requested string) plannedService {
	ps := plannedService{originID: s.ID, originNode: s.NodeID}
	view := catalogService(s)
	spec, err := specFromExport(s)
	if err != nil {
		view.Error = true
		view.Reason = err.Error()
		view.Action = requested
		ps.view = view
		return ps
	}
	ps.spec = spec
	matched := ""
	if node.action == "bind" && node.localID != "" {
		if o, ok := c.findMapOriginLocked(sourceID, s.ID, node.localID); ok {
			matched = o.LocalID
			if m := c.maps[matched]; m != nil {
				view.MatchedLocalID = matched
				view.Diff = specDiff(m.Spec, spec)
			} else {
				matched = ""
			}
		}
	}
	action := requested
	if action == "" {
		if matched != "" {
			action = "skip"
		} else {
			action = "create"
		}
	}
	view.Action = action
	ps.action = action
	ps.localID = matched
	ps.localNodeID = node.localID
	switch action {
	case "skip":
		if matched == "" {
			view.Reason = "将跳过，不创建"
		} else if len(view.Diff) > 0 {
			view.Reason = "已导入，保持现有配置"
		} else {
			view.Reason = "已导入，无变化"
		}
	case "create":
		if matched != "" {
			view.Error = true
			view.Reason = "服务已导入，请选择跳过或更新"
		} else if node.action == "bind" && node.localID == "" {
			view.Error = true
			view.Reason = "节点不可用"
		} else if node.view.Error {
			view.Error = true
			view.Reason = "节点不可用"
		}
	case "update":
		if matched == "" {
			view.Error = true
			view.Reason = "没有可更新的已导入服务"
		} else if node.view.Error {
			view.Error = true
			view.Reason = "节点不可用"
		} else if len(view.Diff) == 0 {
			view.Reason = "与现有配置相同"
		} else {
			view.Reason = "将更新已导入服务"
		}
	default:
		view.Error = true
		view.Reason = "服务操作无效"
	}
	ps.view = view
	return ps
}

func specDiff(old, next wire.Mapping) []previewDiff {
	var d []previewDiff
	add := func(field string, a, b any) {
		if fmt.Sprint(a) != fmt.Sprint(b) {
			d = append(d, previewDiff{Field: field, From: a, To: b})
		}
	}
	add("name", old.Name, next.Name)
	add("proto", old.Proto, next.Proto)
	add("mode", old.Mode, next.Mode)
	add("entryPort", portValue(old.EntryPort), portValue(next.EntryPort))
	add("localHost", old.LocalHost, next.LocalHost)
	add("localPort", old.LocalPort, next.LocalPort)
	add("enabled", old.Enabled, next.Enabled)
	add("maxConns", policy.MaxConns(old.MaxConns), next.MaxConns)
	add("rateKbps", old.RateKbps, next.RateKbps)
	add("allowCidrs", old.AllowCidrs, next.AllowCidrs)
	add("idleTimeoutSec", old.IdleTimeoutSec, next.IdleTimeoutSec)
	add("spaTtlSec", policy.ClampTimeoutSec(old.SpaTTLSec, policy.DefaultSPATimeoutSec), next.SpaTTLSec)
	add("udpIdleTimeoutSec", policy.ClampTimeoutSec(old.UdpIdleTimeoutSec, policy.DefaultUDPIdleSec), next.UdpIdleTimeoutSec)
	return d
}

func portValue(p *int) any {
	if p == nil {
		return nil
	}
	return *p
}

func listenKey(spec wire.Mapping) (string, bool) {
	if !spec.Enabled || spec.Mode == "visitor" || spec.EntryPort == nil {
		return "", false
	}
	return fmt.Sprintf("%s/%d", spec.Proto, *spec.EntryPort), true
}

func (c *Console) portsConflictLocked(planned []wire.Mapping, ignore map[string]struct{}) error {
	seen := map[string]string{}
	for id, m := range c.maps {
		if _, skip := ignore[id]; skip {
			continue
		}
		key, ok := listenKey(m.Spec)
		if !ok {
			continue
		}
		seen[key] = id
	}
	for _, spec := range planned {
		key, ok := listenKey(spec)
		if !ok {
			continue
		}
		if other, ok := seen[key]; ok && other != spec.ID {
			return portConflictError{proto: spec.Proto, port: *spec.EntryPort}
		}
		id := spec.ID
		if id == "" {
			id = "new:" + key
		}
		seen[key] = id
	}
	return nil
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}

func cloneNode(a *nodeRec) *nodeRec {
	if a == nil {
		return nil
	}
	cp := *a
	if a.LastSeen != nil {
		t := *a.LastSeen
		cp.LastSeen = &t
	}
	return &cp
}

func cloneMap(m *mapRec) *mapRec {
	if m == nil {
		return nil
	}
	cp := *m
	cp.Spec.EntryPort = copyPort(m.Spec.EntryPort)
	if m.LastProbe != nil {
		t := *m.LastProbe
		cp.LastProbe = &t
	}
	return &cp
}

func (c *Console) snapshotConfigLocked() configSnap {
	nodes := make(map[string]*nodeRec, len(c.nodes))
	for k, v := range c.nodes {
		nodes[k] = cloneNode(v)
	}
	maps := make(map[string]*mapRec, len(c.maps))
	for k, v := range c.maps {
		maps[k] = cloneMap(v)
	}
	return configSnap{
		nodes:       nodes,
		maps:        maps,
		nodeOrigins: append([]importNodeOrigin(nil), c.nodeOrigins...),
		mapOrigins:  append([]importMapOrigin(nil), c.mapOrigins...),
		audit:       append([]auditRec(nil), c.audit...),
		seq:         c.seq,
		instanceID:  c.instanceID,
	}
}

func (c *Console) restoreConfigLocked(s configSnap) {
	c.nodes = s.nodes
	c.maps = s.maps
	c.nodeOrigins = s.nodeOrigins
	c.mapOrigins = s.mapOrigins
	c.audit = s.audit
	c.seq = s.seq
	c.instanceID = s.instanceID
}

func (c *Console) mintNodeLocked(name, comment, os, arch string, neverExpire bool) (*nodeRec, string, error) {
	name = strings.TrimSpace(name)
	if err := checkNameComment(name, comment); err != nil {
		return nil, "", err
	}
	os, arch = nodePlatform(os, arch)
	id, err := newID("nde")
	if err != nil {
		return nil, "", err
	}
	plain, hash, err := newNodeToken()
	if err != nil {
		return nil, "", err
	}
	until := lifetimeUntil(neverExpire)
	rec := &nodeRec{
		ID: id, Name: name, Comment: strings.TrimSpace(comment),
		OS: os, Arch: arch, TokenHash: hash, TokenUntil: until, TokenNoExpiry: neverExpire,
		Status: "offline", Enabled: true, Created: time.Now(), revealed: plain,
	}
	c.nodes[id] = rec
	c.installToken(hash, id, until)
	return rec, plain, nil
}

func (c *Console) applyImportLocked(bundle ConfigBundle, bindings []importBinding) (*importResult, []string, error) {
	plan := c.buildPlanLocked(bundle, bindings)
	if !plan.canApply {
		return nil, nil, errImportConflict
	}
	snap := c.snapshotConfigLocked()
	newIDs := []string{}
	rollback := func() {
		c.restoreConfigLocked(snap)
		for _, id := range newIDs {
			c.Gate.Revoke(id)
		}
	}
	tokens := map[string]string{}
	localOf := map[string]string{}
	result := &importResult{Summary: plan.summary}
	now := time.Now()

	for _, n := range plan.nodes {
		switch n.action {
		case "create":
			rec, plain, err := c.mintNodeLocked(n.name, n.comment, n.os, n.arch, n.neverExpire)
			if err != nil {
				rollback()
				return nil, nil, err
			}
			newIDs = append(newIDs, rec.ID)
			tokens[rec.ID] = plain
			localOf[n.originID] = rec.ID
			c.upsertNodeOriginLocked(bundle.SourceID, n.originID, rec.ID)
			c.logAudit("node.create", rec.ID, rec.Name+" "+rec.OS+"/"+rec.Arch)
			nr := importNodeResult{
				OriginID: n.originID, LocalID: rec.ID, Action: "create", Name: rec.Name,
				Token: plain, OS: rec.OS, Arch: rec.Arch,
				ExpiresAt: rfc3339(rec.TokenUntil), NeverExpire: rec.TokenNoExpiry,
			}
			result.Nodes = append(result.Nodes, nr)
		case "bind":
			localOf[n.originID] = n.localID
			c.upsertNodeOriginLocked(bundle.SourceID, n.originID, n.localID)
			node := c.nodes[n.localID]
			name := n.localID
			if node != nil {
				name = node.Name
			}
			result.Nodes = append(result.Nodes, importNodeResult{
				OriginID: n.originID, LocalID: n.localID, Action: "bind", Name: name,
			})
		}
	}

	push := map[string]struct{}{}
	for _, n := range plan.nodes {
		localNode := localOf[n.originID]
		if localNode == "" {
			rollback()
			return nil, nil, fmt.Errorf("节点绑定失败")
		}
		for _, s := range n.services {
			switch s.action {
			case "skip":
				result.Services = append(result.Services, importServiceResult{
					OriginID: s.originID, LocalID: s.localID, Name: s.view.Name, Action: "skip", Result: "skipped",
				})
			case "create":
				id, err := newID("map")
				if err != nil {
					rollback()
					return nil, nil, err
				}
				spec := s.spec
				spec.ID = id
				spec.Generation = 1
				m := &mapRec{
					Spec: spec, NodeID: localNode,
					ListenState: "pending", PushState: "pending_offline",
					Created: now, Updated: now,
				}
				c.maps[id] = m
				c.upsertMapOriginLocked(bundle.SourceID, s.originID, localNode, id)
				push[localNode] = struct{}{}
				result.Services = append(result.Services, importServiceResult{
					OriginID: s.originID, LocalID: id, Name: spec.Name, Action: "create", Result: "saved",
				})
			case "update":
				m := c.maps[s.localID]
				if m == nil || m.NodeID != localNode {
					rollback()
					return nil, nil, fmt.Errorf("已导入服务不存在")
				}
				next := s.spec
				next.ID = m.Spec.ID
				next.Generation = m.Spec.Generation
				bumpGeneration(&next)
				m.Spec = next
				m.LastProbe, m.LastPreview, m.LastProbeError = nil, "", ""
				m.Updated = now
				c.upsertMapOriginLocked(bundle.SourceID, s.originID, localNode, m.Spec.ID)
				push[localNode] = struct{}{}
				result.Services = append(result.Services, importServiceResult{
					OriginID: s.originID, LocalID: m.Spec.ID, Name: next.Name, Action: "update", Result: "saved",
				})
			}
		}
	}

	c.logAudit("config.import", bundle.SourceID, fmt.Sprintf(
		"新建节点 %d，绑定 %d，新建服务 %d，更新 %d，跳过 %d",
		plan.summary.NodesCreate, plan.summary.NodesBind, plan.summary.ServicesCreate, plan.summary.ServicesUpdate, plan.summary.ServicesSkip,
	))
	if err := c.save(); err != nil {
		rollback()
		return nil, nil, err
	}
	ids := make([]string, 0, len(push))
	for id := range push {
		ids = append(ids, id)
	}
	result.Saved = true
	return result, ids, nil
}

func (c *Console) enrichImportResultLocked(result *importResult, live map[string]gateNode, stats map[string]gate.MapStat) {
	if result == nil {
		return
	}
	for i, n := range result.Nodes {
		if n.Action != "create" || n.Token == "" {
			continue
		}
		fields := c.enrollFields(n.Token, n.OS, n.Arch)
		if v, ok := fields["installCmd"].(string); ok {
			result.Nodes[i].InstallCmd = v
		}
		if v, ok := fields["dockerCmd"].(string); ok {
			result.Nodes[i].DockerCmd = v
		}
		if v, ok := fields["listen"].(string); ok {
			result.Nodes[i].Listen = v
		}
		if v, ok := fields["caPem"].(string); ok {
			result.Nodes[i].CAPem = v
		}
	}
	for i, s := range result.Services {
		if s.Action == "skip" || s.LocalID == "" {
			continue
		}
		m := c.maps[s.LocalID]
		if m == nil {
			continue
		}
		view := c.mappingView(m, live, stats)
		push, _ := view["pushState"].(string)
		listen, _ := view["listenState"].(string)
		listenErr, _ := view["listenError"].(string)
		result.Services[i].PushState = push
		result.Services[i].ListenState = listen
		result.Services[i].ListenError = listenErr
		switch {
		case listenErr != "" || listen == "error" || push == "error":
			result.Services[i].Result = "listen_error"
		case !m.Spec.Enabled:
			result.Services[i].Result = "saved"
		case push == "pending" || push == "pending_offline":
			result.Services[i].Result = "pending_push"
		default:
			result.Services[i].Result = "saved"
		}
	}
}
