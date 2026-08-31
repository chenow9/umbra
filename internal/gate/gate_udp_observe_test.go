package gate

import (
	"errors"
	"net"
	"testing"
	"time"

	"umbra/internal/stealth"
	"umbra/internal/uplane"
)

type observePacketConn struct {
	writeErr error
	writes   int
	bytes    int
}

func (p *observePacketConn) ReadFrom([]byte) (int, net.Addr, error) {
	return 0, nil, errors.New("read disabled")
}
func (p *observePacketConn) WriteTo(b []byte, _ net.Addr) (int, error) {
	if p.writeErr != nil {
		return 0, p.writeErr
	}
	p.writes++
	p.bytes += len(b)
	return len(b), nil
}
func (p *observePacketConn) Close() error                     { return nil }
func (p *observePacketConn) LocalAddr() net.Addr              { return &net.UDPAddr{} }
func (p *observePacketConn) SetDeadline(time.Time) error      { return nil }
func (p *observePacketConn) SetReadDeadline(time.Time) error  { return nil }
func (p *observePacketConn) SetWriteDeadline(time.Time) error { return nil }

func observeReadyServer(t *testing.T, key []byte, pc net.PacketConn) *Server {
	t.Helper()
	s := New("127.0.0.1", stealth.New(false))
	s.udpPC = pc
	ac := &nodeConn{
		id: "node", online: true, udpBound: true, udpAddr: &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 4400},
		udpOut: &uplane.Writer{Key: key}, udpIn: &uplane.Opener{Key: key},
	}
	ac.udpSeen.Store(time.Now().UnixNano())
	s.nodes["node"] = ac
	return s
}

func TestUPlaneReceiveFailureCounters(t *testing.T) {
	s := New("127.0.0.1", stealth.New(false))
	addr := &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 9999}
	s.handleUPlane(addr, []byte("bad"))
	if got := s.Status().UDPUPlanePeekErrors; got != 1 {
		t.Fatalf("peek errors=%d", got)
	}

	key := make([]byte, 32)
	raw, err := (&uplane.Sealer{Key: key}).Encode("missing", uplane.Packet{Type: uplane.TypeData})
	if err != nil {
		t.Fatal(err)
	}
	s.handleUPlane(addr, raw)
	if got := s.Status().UDPUPlaneUnknownPeer; got != 1 {
		t.Fatalf("unknown peer=%d", got)
	}

	s.nodes["node"] = &nodeConn{id: "node", online: true, udpIn: &uplane.Opener{Key: key}}
	badKey := make([]byte, 32)
	badKey[0] = 1
	raw, err = (&uplane.Sealer{Key: badKey}).Encode("node", uplane.Packet{Type: uplane.TypeData})
	if err != nil {
		t.Fatal(err)
	}
	s.handleUPlane(addr, raw)
	if got := s.Status().UDPUPlaneDecodeErrors; got != 1 {
		t.Fatalf("decode errors=%d", got)
	}
}

func TestSendNodeUDPResultCounters(t *testing.T) {
	key := make([]byte, 32)
	s := New("127.0.0.1", stealth.New(false))
	if got := s.sendNodeUDP("missing", uplane.Packet{Type: uplane.TypeData}); got != udpSendNotReady {
		t.Fatalf("not ready result=%d", got)
	}

	pc := &observePacketConn{}
	s = observeReadyServer(t, []byte("short"), pc)
	if got := s.sendNodeUDP("node", uplane.Packet{Type: uplane.TypeData}); got != udpSendEncodeError {
		t.Fatalf("encode result=%d", got)
	}

	pc = &observePacketConn{writeErr: errors.New("write failed")}
	s = observeReadyServer(t, key, pc)
	if got := s.sendNodeUDP("node", uplane.Packet{Type: uplane.TypeData}); got != udpSendWriteError {
		t.Fatalf("write result=%d", got)
	}

	pc = &observePacketConn{}
	s = observeReadyServer(t, key, pc)
	if got := s.sendNodeUDP("node", uplane.Packet{Type: uplane.TypeData}); got != udpSendOK {
		t.Fatalf("success result=%d", got)
	}
	st := s.Status()
	if st.UDPUPlaneTxPackets != 1 || st.UDPUPlaneTxBytes == 0 || pc.writes != 1 {
		t.Fatalf("tx packets=%d bytes=%d writes=%d", st.UDPUPlaneTxPackets, st.UDPUPlaneTxBytes, pc.writes)
	}
}

func TestDeliverFromNodeFailureCounters(t *testing.T) {
	s := New("127.0.0.1", stealth.New(false))
	e := &entry{spec: Mapping{ID: "map", Proto: "udp", Enabled: true}, udpSess: map[string]*udpSess{}}
	s.ent["map"] = e
	pkt := uplane.Packet{Type: uplane.TypeData, MappingID: "map", FlowID: "flow", Payload: []byte("x")}
	s.deliverFromNode(pkt)
	if got := e.udpDropUnknownFlow.Load(); got != 1 {
		t.Fatalf("unknown flow=%d", got)
	}

	pc := &observePacketConn{writeErr: errors.New("client write failed")}
	e.udpSess[udpFlowIndex("flow")] = &udpSess{pc: pc, raddr: &net.UDPAddr{Port: 1}, flowID: "flow"}
	s.deliverFromNode(pkt)
	if got := e.udpDropClientWrite.Load(); got != 1 {
		t.Fatalf("client write=%d", got)
	}
}

func TestUDPDropReasonCounters(t *testing.T) {
	e := &entry{}
	for _, reason := range []string{
		"acl", "spa", "traffic_limit", "no_path", "encode", "uplane_write",
		"tunnel_write", "unknown_flow", "client_write",
	} {
		e.noteUDPDrop("127.0.0.1", reason)
	}
	if e.udpDropACL.Load() != 1 || e.udpDropSPA.Load() != 1 || e.udpDropTrafficLimit.Load() != 1 ||
		e.udpDropNoPath.Load() != 1 || e.udpDropEncode.Load() != 1 || e.udpDropUPlaneWrite.Load() != 1 ||
		e.udpDropTunnelWrite.Load() != 1 || e.udpDropUnknownFlow.Load() != 1 || e.udpDropClientWrite.Load() != 1 {
		t.Fatalf("unexpected counters: %+v", e)
	}
}
