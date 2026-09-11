package control

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

func (c *Console) postExport(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Nodes []exportNodeSel `json:"nodes"`
	}
	if !jsonBody(w, r, &b) {
		return
	}
	c.mu.Lock()
	prevID, prevSeq := c.instanceID, c.seq
	prevAudit := append([]auditRec(nil), c.audit...)
	bundle, err := c.exportBundleLocked(b.Nodes)
	if err != nil {
		c.instanceID, c.seq, c.audit = prevID, prevSeq, prevAudit
		c.mu.Unlock()
		writeErr(w, 400, err.Error())
		return
	}
	if err := c.save(); err != nil {
		c.instanceID, c.seq, c.audit = prevID, prevSeq, prevAudit
		c.mu.Unlock()
		persistFail(w)
		return
	}
	c.mu.Unlock()
	writeJSON(w, bundle)
}

func readImportRequest(w http.ResponseWriter, r *http.Request) (importRequest, bool) {
	var req importRequest
	raw, err := readRawJSON(r, importJSONLimit)
	if err != nil {
		var mb *http.MaxBytesError
		if errors.As(err, &mb) {
			writeErr(w, http.StatusRequestEntityTooLarge, "请求过大")
			return req, false
		}
		writeErr(w, 400, "bad json")
		return req, false
	}
	if err := inspectImportPayload(raw); err != nil {
		writeErr(w, 400, err.Error())
		return req, false
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		writeErr(w, 400, "bad json")
		return req, false
	}
	if err := validateBundle(&req.Bundle); err != nil {
		writeErr(w, 400, err.Error())
		return req, false
	}
	return req, true
}

func readRawJSON(r *http.Request, limit int64) ([]byte, error) {
	defer r.Body.Close()
	r.Body = http.MaxBytesReader(nil, r.Body, limit)
	return io.ReadAll(r.Body)
}

func (c *Console) postImportPreview(w http.ResponseWriter, r *http.Request) {
	req, ok := readImportRequest(w, r)
	if !ok {
		return
	}
	live := c.live()
	c.mu.Lock()
	prev := c.previewImportLocked(req.Bundle, req.Bindings, live)
	c.mu.Unlock()
	writeJSON(w, prev)
}

func (c *Console) postImport(w http.ResponseWriter, r *http.Request) {
	req, ok := readImportRequest(w, r)
	if !ok {
		return
	}
	live := c.live()
	c.mu.Lock()
	result, pushIDs, err := c.applyImportLocked(req.Bundle, req.Bindings)
	if err != nil {
		if errors.Is(err, errImportConflict) {
			prev := c.previewImportLocked(req.Bundle, req.Bindings, live)
			c.mu.Unlock()
			w.Header().Set("content-type", "application/json")
			w.WriteHeader(http.StatusConflict)
			_ = json.NewEncoder(w).Encode(prev)
			return
		}
		persist := errors.Is(err, errPersist)
		c.mu.Unlock()
		if persist {
			persistFail(w)
			return
		}
		writeRandFail(w)
		return
	}
	c.mu.Unlock()
	for _, id := range pushIDs {
		c.push(id)
	}
	live = c.live()
	stats := c.Gate.MappingStats()
	c.mu.Lock()
	c.enrichImportResultLocked(result, live, stats)
	c.mu.Unlock()
	writeJSON(w, result)
}
