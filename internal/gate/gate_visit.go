package gate

import (
	"encoding/json"
	"net"
	"sync"
	"time"

	"github.com/hashicorp/yamux"

	"umbra/internal/policy"
	"umbra/internal/wire"
)

func (s *Server) runVisitor(raw net.Conn, sess *yamux.Session, wc *wire.Conn, first wire.Envelope) {
	var b struct {
		Ticket string `json:"ticket"`
	}
	if err := json.Unmarshal(first.Body, &b); err != nil || b.Ticket == "" {
		_ = wc.SendJSON("Dropped", map[string]string{"reason": "bad_ticket"})
		return
	}
	t, ok := s.lookupTicket(TicketHash(b.Ticket))
	if !ok {
		_ = wc.SendJSON("Dropped", map[string]string{"reason": "bad_ticket"})
		return
	}
	m, nodeID, ok := s.mappingByID(t.MappingID)
	if !ok || !m.Enabled || m.Mode != "visitor" {
		_ = wc.SendJSON("Dropped", map[string]string{"reason": "no_mapping"})
		return
	}
	ip := policy.NormalizeIP(raw.RemoteAddr().String())
	if !policy.CidrAllowed(ip, m.AllowCidrs) {
		_ = wc.SendJSON("Dropped", map[string]string{"reason": "acl"})
		return
	}
	s.mu.Lock()
	ac := s.nodes[nodeID]
	online := ac != nil && ac.online && ac.sess != nil
	s.mu.Unlock()
	if !online {
		_ = wc.SendJSON("Dropped", map[string]string{"reason": "offline"})
		return
	}
	visID := "vis_" + hexCookie(newUDPCookie())[:16]
	keys := s.issueUDP(raw)
	s.mu.Lock()
	vu := &visitUDP{id: visID, mapID: m.ID, nodeID: nodeID, proto: m.Proto, mode: m.Mode, mux: sess}
	if keys != nil {
		vu.cookie, vu.in, vu.out = keys.cookie, keys.in, keys.out
	}
	s.visits[visID] = vu
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.visits, visID)
		s.mu.Unlock()
		s.dropVisitUDP(visID)
	}()
	hello := map[string]any{
		"mapping_id": m.ID, "proto": m.Proto, "name": m.Name,
		"visit_id": visID, "udp_mode": string(s.udpMode),
	}
	if keys != nil {
		hello["udp_cookie"] = hexCookie(keys.cookie)
	}
	if err := wc.SendJSON("VisitOk", hello); err != nil {
		return
	}
	go func() {
		for {
			if _, err := wc.Read(); err != nil {
				_ = sess.Close()
				return
			}
		}
	}()
	for {
		st, err := sess.AcceptStream()
		if err != nil {
			return
		}
		go s.handleVisitStream(st, m, nodeID)
	}
}

func (s *Server) handleVisitStream(st net.Conn, m wire.Mapping, nodeID string) {
	defer st.Close()
	_ = st.SetDeadline(time.Now().Add(8 * time.Second))
	o, err := wire.ReadOpen(st)
	if err != nil {
		return
	}
	_ = st.SetDeadline(time.Time{})
	if o.MappingID != "" && o.MappingID != m.ID {
		return
	}
	o.MappingID = m.ID
	o.Via = "visitor"
	if o.Proto != "" && o.Proto != m.Proto {
		return
	}
	o.Proto = m.Proto
	s.mu.Lock()
	e := s.ent[m.ID]
	s.mu.Unlock()
	if e == nil {
		return
	}
	if o.Proto == "udp" || m.Proto == "udp" {
		if s.udpMode == UDPRequired {
			return
		}
		s.bridgeUDP(e, nodeID, st, o)
		return
	}
	s.spliceToNode(e, st, o)
}

func (s *Server) bridgeUDP(e *entry, nodeID string, peer net.Conn, o wire.StreamOpen) {
	st, e2, err := s.openToNode(nodeID, o)
	if err != nil {
		return
	}
	if e2 != nil {
		e = e2
	}
	defer e.release()
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for {
			p, err := wire.ReadDatagram(peer)
			if err != nil {
				_ = st.Close()
				return
			}
			if !e.take(len(p)) {
				continue
			}
			if err := wire.WriteDatagram(st, p); err != nil {
				return
			}
			e.in.Add(int64(len(p)))
			e.pin.Add(1)
		}
	}()
	go func() {
		defer wg.Done()
		for {
			p, err := wire.ReadDatagram(st)
			if err != nil {
				_ = peer.Close()
				return
			}
			if err := wire.WriteDatagram(peer, p); err != nil {
				return
			}
			e.out.Add(int64(len(p)))
			e.pout.Add(1)
		}
	}()
	wg.Wait()
	_ = st.Close()
	_ = peer.Close()
}
