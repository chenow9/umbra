package control

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

func (c *Console) getEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, http.StatusInternalServerError, "不支持流式响应")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	_ = http.NewResponseController(w).SetWriteDeadline(time.Time{})

	send := func() bool {
		payload, err := json.Marshal(c.livePayload())
		if err != nil {
			return false
		}
		if _, err := fmt.Fprintf(w, "event: live\ndata: %s\n\n", payload); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	if !send() {
		return
	}
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		if c.draining.Load() {
			return
		}
		select {
		case <-c.drainCh:
			return
		case <-r.Context().Done():
			return
		case <-tick.C:
			if !send() {
				return
			}
		}
	}
}
