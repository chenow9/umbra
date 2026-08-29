package control

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"umbra/internal/policy"
)

func (c *Console) patchNode(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var b struct {
		Name    *string `json:"name"`
		Comment *string `json:"comment"`
		OS      *string `json:"os"`
		Arch    *string `json:"arch"`
	}
	if !jsonBody(w, r, &b) {
		return
	}
	c.mu.Lock()
	a := c.nodes[id]
	if a == nil {
		c.mu.Unlock()
		writeErr(w, 404, "节点不存在")
		return
	}
	prevName, prevComment, prevOS, prevArch := a.Name, a.Comment, a.OS, a.Arch
	if b.Name != nil {
		name := strings.TrimSpace(*b.Name)
		if name == "" {
			c.mu.Unlock()
			writeErr(w, 400, "需要名称")
			return
		}
		a.Name = name
	}
	if b.Comment != nil {
		a.Comment = strings.TrimSpace(*b.Comment)
	}
	if b.OS != nil {
		a.OS = strings.TrimSpace(*b.OS)
	}
	if b.Arch != nil {
		a.Arch = strings.TrimSpace(*b.Arch)
	}
	c.logAudit("node.update", id, a.Name)
	if err := c.save(); err != nil {
		a.Name, a.Comment, a.OS, a.Arch = prevName, prevComment, prevOS, prevArch
		c.mu.Unlock()
		persistFail(w)
		return
	}
	c.mu.Unlock()
	live := c.live()
	stats := c.Gate.MappingStats()
	c.mu.Lock()
	view := c.nodeView(a, live, stats)
	c.mu.Unlock()
	writeJSON(w, view)
}

func readDeleteForce(r *http.Request) bool {
	force := r.URL.Query().Get("force") == "1"
	if r.Body == nil {
		return force
	}
	defer r.Body.Close()
	r.Body = http.MaxBytesReader(nil, r.Body, jsonBodyLimit)
	var b struct {
		Force bool `json:"force"`
	}
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(&b); err != nil {
		if errors.Is(err, io.EOF) {
			return force
		}
		var mb *http.MaxBytesError
		if errors.As(err, &mb) {
			return force
		}
		return force
	}
	return force || b.Force
}

func (c *Console) postDeleteNode(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	force := readDeleteForce(r)
	c.mu.Lock()
	a := c.nodes[id]
	if a == nil {
		c.mu.Unlock()
		writeErr(w, 404, "节点不存在")
		return
	}
	mapIDs := []string{}
	for mid, m := range c.maps {
		if m.NodeID == id {
			mapIDs = append(mapIDs, mid)
		}
	}
	if len(mapIDs) > 0 && !force {
		c.mu.Unlock()
		writeErr(w, http.StatusConflict, "节点下还有映射，删除前请先删映射，或 force=1")
		return
	}

	prevNode := *a
	prevMaps := map[string]*mapRec{}
	prevTickets := map[string]*ticketRec{}
	for _, mid := range mapIDs {
		if m := c.maps[mid]; m != nil {
			cp := *m
			prevMaps[mid] = &cp
		}
	}
	for tid, t := range c.tickets {
		for _, mid := range mapIDs {
			if t.MappingID == mid {
				cp := *t
				prevTickets[tid] = &cp
				break
			}
		}
	}
	prevRevoked := c.snapshotRevoked()

	c.revokeHash(a.TokenHash)
	c.revokeHash(a.PrevHash)
	for tid := range prevTickets {
		delete(c.tickets, tid)
	}
	for _, mid := range mapIDs {
		delete(c.maps, mid)
	}
	delete(c.nodes, id)
	c.logAudit("node.delete", id, prevNode.Name)

	if err := c.save(); err != nil {
		c.nodes[id] = &prevNode
		for mid, rec := range prevMaps {
			c.maps[mid] = rec
		}
		for tid, t := range prevTickets {
			c.tickets[tid] = t
		}
		c.revoked = prevRevoked
		c.mu.Unlock()
		persistFail(w)
		return
	}
	c.mu.Unlock()
	for _, mid := range mapIDs {
		c.Gate.DeleteTicketsFor(mid)
	}
	c.Gate.Revoke(id)
	writeJSON(w, map[string]any{"ok": true})
}

func (c *Console) patchMapping(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var b struct {
		NodeID         *string `json:"nodeId"`
		AgentID        *string `json:"agentId"`
		Name           *string `json:"name"`
		Proto          *string `json:"proto"`
		Mode           *string `json:"mode"`
		EntryPort      *int    `json:"entryPort"`
		LocalHost      *string `json:"localHost"`
		LocalPort      *int    `json:"localPort"`
		MaxConns       *int    `json:"maxConns"`
		RateKbps       *int    `json:"rateKbps"`
		AllowCidrs     *string `json:"allowCidrs"`
		IdleTimeoutSec *int    `json:"idleTimeoutSec"`
	}
	if !jsonBody(w, r, &b) {
		return
	}
	c.mu.Lock()
	m := c.maps[id]
	if m == nil {
		c.mu.Unlock()
		writeErr(w, 404, "映射不存在")
		return
	}
	nodeID := m.NodeID
	if b.NodeID != nil && strings.TrimSpace(*b.NodeID) != "" {
		nodeID = strings.TrimSpace(*b.NodeID)
	} else if b.AgentID != nil && strings.TrimSpace(*b.AgentID) != "" {
		nodeID = strings.TrimSpace(*b.AgentID)
	}
	node := c.nodes[nodeID]
	if node == nil {
		c.mu.Unlock()
		writeErr(w, 404, "节点不存在")
		return
	}
	if node.Status == "revoked" || !node.Enabled {
		c.mu.Unlock()
		writeErr(w, 400, "节点已吊销")
		return
	}

	next := m.Spec
	if b.Name != nil {
		name := strings.TrimSpace(*b.Name)
		if name == "" {
			c.mu.Unlock()
			writeErr(w, 400, "需要名称")
			return
		}
		next.Name = name
	}
	if b.Proto != nil {
		next.Proto = *b.Proto
	}
	if b.Mode != nil {
		next.Mode = *b.Mode
	}
	if b.LocalHost != nil {
		next.LocalHost = strings.TrimSpace(*b.LocalHost)
	}
	if b.LocalPort != nil {
		next.LocalPort = *b.LocalPort
	}
	if next.Mode == "visitor" {
		next.EntryPort = nil
	} else if b.EntryPort != nil {
		next.EntryPort = b.EntryPort
	}
	if b.MaxConns != nil {
		next.MaxConns = policy.MaxConns(*b.MaxConns)
	}
	if b.IdleTimeoutSec != nil {
		idle := *b.IdleTimeoutSec
		if idle < 0 {
			idle = 0
		}
		next.IdleTimeoutSec = idle
	}
	if b.RateKbps != nil {
		next.RateKbps = *b.RateKbps
	}
	if b.AllowCidrs != nil {
		next.AllowCidrs = *b.AllowCidrs
	}
	if err := validateMapping(next.Proto, next.Mode, next.EntryPort, next.LocalHost, next.LocalPort); err != nil {
		c.mu.Unlock()
		writeErr(w, 400, err.Error())
		return
	}
	if next.Enabled {
		if err := c.portTaken(id, next); err != nil {
			c.mu.Unlock()
			writeErr(w, 400, err.Error())
			return
		}
	}

	prev := *m
	oldNode := m.NodeID
	bumpGeneration(&next)
	m.Spec = next
	m.NodeID = nodeID
	m.Updated = time.Now()
	c.logAudit("mapping.update", id, next.Name)
	if err := c.save(); err != nil {
		*m = prev
		c.mu.Unlock()
		persistFail(w)
		return
	}
	c.mu.Unlock()
	c.push(oldNode)
	if nodeID != oldNode {
		c.push(nodeID)
	}
	live := c.live()
	stats := c.Gate.MappingStats()
	c.mu.Lock()
	view := c.mappingView(m, live, stats)
	c.mu.Unlock()
	writeJSON(w, view)
}
