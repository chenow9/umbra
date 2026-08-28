package gate

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"net"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/hashicorp/yamux"

	"umbra/internal/policy"
	"umbra/internal/uplane"
)

const defaultUDPReadyTTL = 15 * time.Second

// udpReadyTTLNS is the last-seen TTL for node uplane readiness, in nanoseconds.
// Zero means defaultUDPReadyTTL. Tests may store a shorter value.
var udpReadyTTLNS atomic.Int64

func udpReadyTTL() time.Duration {
	d := time.Duration(udpReadyTTLNS.Load())
	if d <= 0 {
		return defaultUDPReadyTTL
	}
	return d
}

type visitUDP struct {
	id     string
	cookie []byte
	in     *uplane.Opener
	out    *uplane.Sealer
	addr   net.Addr
	bound  bool
	seen   atomic.Int64
	mapID  string
	nodeID string
	proto  string
	mode   string
	mux    *yamux.Session
}

type udpCred struct {
	cookie []byte
	in     *uplane.Opener
	out    *uplane.Sealer
}

func (s *Server) AttachUPlane(pc net.PacketConn) {
	s.mu.Lock()
	s.udpPC = pc
	s.mu.Unlock()
	go s.serveUPlane(pc)
}

func (s *Server) serveUPlane(pc net.PacketConn) {
	buf := uplane.GetBuf()
	defer uplane.PutBuf(buf)
	for {
		n, addr, err := pc.ReadFrom(buf)
		if err != nil {
			return
		}
		s.handleUPlane(addr, append([]byte(nil), buf[:n]...))
	}
}

func (s *Server) handleUPlane(addr net.Addr, raw []byte) {
	id, err := uplane.PeekID(raw)
	if err != nil {
		return
	}
	s.mu.Lock()
	var opener *uplane.Opener
	online := false
	if ac := s.nodes[id]; ac != nil {
		opener, online = ac.udpIn, ac.online
	} else if v := s.visits[id]; v != nil {
		opener, online = v.in, true
	}
	s.mu.Unlock()
	if opener == nil || !online {
		return
	}
	_, pkt, err := opener.Decode(raw)
	if err != nil {
		return
	}
	switch pkt.Type {
	case uplane.TypeBind:
		s.onUDPBind(id, addr, pkt)
	case uplane.TypeBindConfirm:
		s.onUDPConfirm(id, addr, pkt)
	case uplane.TypeData:
		s.onUDPData(id, addr, pkt)
	case uplane.TypeClose:
		s.onUDPClose(id, pkt)
	}
}

func (s *Server) onUDPBind(id string, addr net.Addr, pkt uplane.Packet) {
	s.mu.Lock()
	var out *uplane.Sealer
	var cookie []byte
	if ac := s.nodes[id]; ac != nil && ac.online {
		if subtle.ConstantTimeCompare(pkt.Payload, ac.udpCookie) != 1 {
			s.mu.Unlock()
			return
		}
		ac.udpBindOK = true
		out, cookie = ac.udpOut, ac.udpCookie
	} else if v := s.visits[id]; v != nil {
		if subtle.ConstantTimeCompare(pkt.Payload, v.cookie) != 1 {
			s.mu.Unlock()
			return
		}
		out, cookie = v.out, v.cookie
	}
	pc := s.udpPC
	s.mu.Unlock()
	if out == nil || pc == nil {
		return
	}
	raw, err := out.Encode(id, uplane.Packet{Type: uplane.TypeBindAck, Payload: cookie})
	if err != nil {
		return
	}
	_, _ = pc.WriteTo(raw, addr)
}

func (s *Server) onUDPConfirm(id string, addr net.Addr, pkt uplane.Packet) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ac := s.nodes[id]; ac != nil && ac.online {
		if !ac.udpBindOK || subtle.ConstantTimeCompare(pkt.Payload, ac.udpCookie) != 1 {
			return
		}
		s.markNodeUDPReady(ac, addr)
		return
	}
	if v := s.visits[id]; v != nil {
		if subtle.ConstantTimeCompare(pkt.Payload, v.cookie) != 1 {
			return
		}
		v.addr = addr
		v.bound = true
		v.seen.Store(time.Now().UnixNano())
	}
}

func (s *Server) markNodeUDPReady(ac *nodeConn, addr net.Addr) {
	ac.udpAddr = addr
	ac.udpBound = true
	ac.udpSeen.Store(time.Now().UnixNano())
}

func (s *Server) onUDPData(id string, addr net.Addr, pkt uplane.Packet) {
	s.mu.Lock()
	if ac := s.nodes[id]; ac != nil {
		if !ac.online || ac.udpIn == nil {
			s.mu.Unlock()
			return
		}
		if ac.udpBindOK {
			s.markNodeUDPReady(ac, addr)
		}
		e := s.ent[pkt.MappingID]
		ok := e != nil && e.nodeID == id && e.spec.Enabled && e.spec.Proto == "udp"
		s.mu.Unlock()
		if !ok {
			return
		}
		s.deliverFromNode(pkt)
		return
	}
	v := s.visits[id]
	if v == nil {
		s.mu.Unlock()
		return
	}
	v.addr = addr
	v.bound = true
	v.seen.Store(time.Now().UnixNano())
	nodeID, visID, mapID := v.nodeID, v.id, v.mapID
	proto, mode := v.proto, v.mode
	e := s.ent[pkt.MappingID]
	ok := pkt.MappingID == mapID && pkt.FlowID != "" && e != nil && e.nodeID == nodeID && e.spec.Enabled && e.spec.Proto == "udp" && e.spec.Mode == "visitor" && proto == "udp" && mode == "visitor"
	s.mu.Unlock()
	if !ok {
		return
	}
	s.forwardVisitUDP(nodeID, visID, pkt)
}

func (s *Server) dropVisitUDP(visID string) {
	s.mu.Lock()
	ents := make([]*entry, 0, len(s.ent))
	for _, e := range s.ent {
		ents = append(ents, e)
	}
	s.mu.Unlock()
	for _, e := range ents {
		e.mu.Lock()
		seen := map[*udpSess]bool{}
		for _, sess := range e.udpSess {
			if sess == nil || sess.visitID != visID || seen[sess] {
				continue
			}
			seen[sess] = true
			e.dropUDPSessLocked(sess)
		}
		e.mu.Unlock()
	}
}

func (s *Server) onUDPClose(id string, pkt uplane.Packet) {
	s.mu.Lock()
	e := s.ent[pkt.MappingID]
	fromNode := false
	visOwner := ""
	if ac := s.nodes[id]; ac != nil {
		fromNode = ac.online && e != nil && e.nodeID == id
	} else if v := s.visits[id]; v != nil {
		fromNode = e != nil && pkt.MappingID == v.mapID
		visOwner = v.id
	}
	s.mu.Unlock()
	if !fromNode || e == nil {
		return
	}
	key := udpSessKey(pkt)
	e.mu.Lock()
	if sess := e.udpSess[key]; sess != nil {
		if visOwner != "" && sess.visitID != visOwner {
			e.mu.Unlock()
			return
		}
		e.dropUDPSessLocked(sess)
		st := sess.st
		e.mu.Unlock()
		if st != nil {
			_ = st.Close()
		}
		return
	}
	e.mu.Unlock()
}

func (s *Server) deliverFromNode(pkt uplane.Packet) {
	s.mu.Lock()
	e := s.ent[pkt.MappingID]
	s.mu.Unlock()
	if e == nil {
		return
	}
	key := udpSessKey(pkt)
	e.mu.Lock()
	sess := e.udpSess[key]
	if sess == nil {
		e.mu.Unlock()
		return
	}
	visID := sess.visitID
	pc, raddr := sess.pc, sess.raddr
	sess.touchLocked(e, key)
	e.mu.Unlock()
	if visID != "" {
		if s.sendVisitUDP(visID, pkt) {
			e.out.Add(int64(len(pkt.Payload)))
			e.pout.Add(1)
		}
		return
	}
	if pc == nil || raddr == nil {
		return
	}
	if _, err := pc.WriteTo(pkt.Payload, raddr); err == nil {
		e.out.Add(int64(len(pkt.Payload)))
		e.pout.Add(1)
	}
}

func (s *Server) forwardVisitUDP(nodeID, visID string, pkt uplane.Packet) {
	s.mu.Lock()
	e := s.ent[pkt.MappingID]
	s.mu.Unlock()
	if e == nil {
		return
	}
	if !e.take(len(pkt.Payload)) {
		return
	}
	if pkt.FlowID == "" {
		return
	}
	key := udpFlowIndex(pkt.FlowID)
	idle := time.Duration(policy.IntOr(e.spec.IdleTimeoutSec, 60)) * time.Second
	e.mu.Lock()
	sess := e.udpSess[key]
	if sess == nil {
		if reason := e.admitUDP(visID); reason != "" {
			e.mu.Unlock()
			e.noteUDPDrop(visID, reason)
			return
		}
		sess = &udpSess{idle: idle, visitID: visID, flowID: pkt.FlowID, path: udpPathUPlane, admitIP: udpAdmitKey(visID)}
		mapID, nodeID, flowID := e.spec.ID, e.nodeID, sess.flowID
		sess.closer = func() {
			_ = s.sendNodeUDP(nodeID, uplane.Packet{Type: uplane.TypeClose, MappingID: mapID, FlowID: flowID})
		}
		e.putUDPSess(sess)
		e.udpViaUplane.Store(true)
	}
	if sess.visitID != "" && sess.visitID != visID {
		e.mu.Unlock()
		return
	}
	if sess.path == udpPathNone {
		sess.path = udpPathUPlane
		e.udpViaUplane.Store(true)
	}
	if sess.path != udpPathUPlane {
		e.mu.Unlock()
		return
	}
	sess.visitID = visID
	sess.touchLocked(e, key)
	e.mu.Unlock()
	if !s.sendNodeUDP(nodeID, pkt) {
		return
	}
	e.in.Add(int64(len(pkt.Payload)))
	e.pin.Add(1)
}

func (s *Server) sendNodeUDP(nodeID string, pkt uplane.Packet) bool {
	s.mu.Lock()
	ac := s.nodes[nodeID]
	pc := s.udpPC
	var out *uplane.Sealer
	var addr net.Addr
	var id string
	if ac != nil && ac.online && ac.udpBound && ac.udpAddr != nil && ac.udpOut != nil && udpSeenFresh(ac.udpSeen.Load()) {
		out, addr, id = ac.udpOut, ac.udpAddr, ac.id
	}
	s.mu.Unlock()
	if pc == nil || addr == nil || out == nil {
		return false
	}
	raw, err := out.Encode(id, pkt)
	if err != nil {
		return false
	}
	_, err = pc.WriteTo(raw, addr)
	return err == nil
}

func (s *Server) sendVisitUDP(visitID string, pkt uplane.Packet) bool {
	s.mu.Lock()
	v := s.visits[visitID]
	pc := s.udpPC
	s.mu.Unlock()
	if v == nil || !v.bound || v.addr == nil || pc == nil || v.out == nil {
		return false
	}
	raw, err := v.out.Encode(v.id, pkt)
	if err != nil {
		return false
	}
	_, err = pc.WriteTo(raw, v.addr)
	return err == nil
}

func (s *Server) nodeUDPReady(nodeID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	ac := s.nodes[nodeID]
	return ac != nil && ac.online && ac.udpBound && ac.udpAddr != nil && ac.udpOut != nil && s.udpPC != nil && s.udpMode != UDPYamux && udpSeenFresh(ac.udpSeen.Load())
}

func udpSeenFresh(seen int64) bool {
	return seen > 0 && time.Since(time.Unix(0, seen)) < udpReadyTTL()
}

func udpFlowIndex(flowID string) string { return "f:" + flowID }
func udpPeerIndex(peer string) string   { return "p:" + peer }

func udpSessKey(pkt uplane.Packet) string {
	if pkt.FlowID != "" {
		return udpFlowIndex(pkt.FlowID)
	}
	return udpPeerIndex(udpPeerKey(pkt.PeerIP, pkt.PeerPort))
}

func (e *entry) putUDPSess(sess *udpSess) {
	if sess.flowID != "" {
		e.udpSess[udpFlowIndex(sess.flowID)] = sess
	}
	if sess.peerKey != "" {
		e.udpSess[udpPeerIndex(sess.peerKey)] = sess
	}
}

func (e *entry) delUDPSess(sess *udpSess) {
	if sess.flowID != "" {
		delete(e.udpSess, udpFlowIndex(sess.flowID))
	}
	if sess.peerKey != "" {
		delete(e.udpSess, udpPeerIndex(sess.peerKey))
	}
}

func (s *Server) issueUDP(raw net.Conn) *udpCred {
	if s.udpMode == UDPYamux || s.udpPC == nil {
		return nil
	}
	ekm := uplane.ExportEKM(raw)
	if len(ekm) != 32 {
		return nil
	}
	cookie := newUDPCookie()
	c2s, s2c := uplane.DerivePair(ekm, cookie)
	return &udpCred{cookie: cookie, in: &uplane.Opener{Key: c2s}, out: &uplane.Sealer{Key: s2c}}
}

func (s *Server) clearNodeUDP(ac *nodeConn) {
	ac.udpAddr = nil
	ac.udpCookie = nil
	ac.udpBindOK = false
	ac.udpBound = false
	ac.udpSeen.Store(0)
	ac.udpIn = nil
	ac.udpOut = nil
}

func newUDPCookie() []byte {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return b
}

func hexCookie(c []byte) string { return hex.EncodeToString(c) }

func udpPeerKey(ip net.IP, port int) string {
	if ip == nil {
		return net.JoinHostPort("", strconv.Itoa(port))
	}
	if v4 := ip.To4(); v4 != nil {
		return net.JoinHostPort(v4.String(), strconv.Itoa(port))
	}
	return net.JoinHostPort(ip.String(), strconv.Itoa(port))
}

func (sess *udpSess) touchLocked(e *entry, key string) {
	if sess == nil {
		return
	}
	sess.deadline.Store(time.Now().Add(sess.idle).UnixNano())
	if sess.timer == nil {
		sess.timer = time.AfterFunc(sess.idle, func() { sess.expire(e, key) })
		return
	}
	sess.timer.Reset(sess.idle)
}

func (sess *udpSess) expire(e *entry, key string) {
	e.mu.Lock()
	remain := time.Until(time.Unix(0, sess.deadline.Load()))
	if remain > 0 {
		if sess.timer != nil {
			sess.timer.Reset(remain)
		}
		e.mu.Unlock()
		return
	}
	if e.udpSess[key] != sess {
		e.mu.Unlock()
		return
	}
	e.dropUDPSessLocked(sess)
	delete(e.udpSess, key)
	st := sess.st
	closer := sess.closer
	e.mu.Unlock()
	if st != nil {
		go st.Close()
	}
	if closer != nil {
		go closer()
	}
}
