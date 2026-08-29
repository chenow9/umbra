// Load generator for Umbra public TCP/UDP mappings.
//
// Modes:
//
//	rr        closed-loop request/response (default). interval=0 means no extra sleep, still one request in flight.
//	stream    TCP: independent writer/reader, byte counters, no per-chunk echo wait.
//	openloop  UDP: sender at fixed pps, receiver independent; timeouts do not slow the sender.
//
// Hold throughput uses only the hold window (setup elapsed is separate).
package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math/rand"
	"net"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

const (
	udpMagic     = "UB01"
	udpHeaderLen = 4 + 4 + 8 + 8
	udpSafeTotal = 1200
)

var errCorrupt = errors.New("corrupt")

type udpFlow struct {
	c    net.Conn
	id   uint32
	seq  atomic.Uint64
	wbuf []byte
	rbuf []byte
}

type result struct {
	Proto, Addr, Mode                               string
	N, Size                                         int
	Interval, Timeout, Hold                         string
	SetupElapsed                                    string
	Connect                                         string `json:",omitempty"`
	FirstEchoRTT                                    string `json:",omitempty"`
	FirstEchoOK                                     int64
	FirstEchoTimeoutOrError                         int64
	FirstEchoBytes                                  int64
	HoldElapsed                                     string
	HoldBytes                                       int64
	HoldRate                                        string
	HoldTx, HoldRx                                  int64  `json:",omitempty"`
	HoldTxRate, HoldRxRate                          string `json:",omitempty"`
	HoldAttempts, HoldSuccess, HoldErrors           int64
	AliveAtDeadline, FinalProbeOK, FailedDuringHold int64
	UDPSent, UDPRecv, UDPHoldRecv, UDPGraceRecv     int64   `json:",omitempty"`
	UDPTimeout, UDPLate, UDPDup, UDPOOO, UDPCorrupt int64   `json:",omitempty"`
	UDPLossRate                                     float64 `json:",omitempty"`
	TxErr, RxErr, Inflight, DrainBytes              int64   `json:",omitempty"`
	DrainElapsed                                    string  `json:",omitempty"`
	TotalElapsed                                    string
}

func main() {
	addr := flag.String("addr", "127.0.0.1:18000", "public mapping address")
	n := flag.Int("n", 10000, "connections or UDP flows")
	hold := flag.Duration("hold", 15*time.Second, "measurement window after setup")
	payload := flag.String("msg", "umbra-bench\n", "TCP payload when -size=0")
	size := flag.Int("size", 32*1024, "TCP write size; UDP datagram size including 24B header")
	timeout := flag.Duration("timeout", 30*time.Second, "per-op timeout, clipped to hold deadline")
	interval := flag.Duration("interval", time.Second, "RR min wait between echoes; 0 = no extra sleep")
	par := flag.Int("par", 256, "dial concurrency")
	proto := flag.String("proto", "tcp", "tcp or udp")
	mode := flag.String("mode", "rr", "rr | stream | openloop")
	pps := flag.Float64("pps", 0, "UDP openloop packets per second per flow; 0 uses 1/interval")
	probe := flag.Duration("probe-timeout", 2*time.Second, "final RR probe timeout after hold")
	jsonPath := flag.String("json", "", "write one JSON result object to this file")
	echoTCP := flag.String("echo", "", "TCP echo server")
	echoUDP := flag.String("echo-udp", "", "UDP echo server")
	flag.Parse()

	if *echoTCP != "" || *echoUDP != "" {
		runEcho(*echoTCP, *echoUDP)
		return
	}
	p := strings.ToLower(*proto)
	m := strings.ToLower(*mode)
	if p != "tcp" && p != "udp" {
		fmt.Fprintln(os.Stderr, "proto must be tcp or udp")
		os.Exit(2)
	}
	if m != "rr" && m != "stream" && m != "openloop" {
		fmt.Fprintln(os.Stderr, "mode must be rr, stream, or openloop")
		os.Exit(2)
	}
	if m == "stream" && p != "tcp" {
		fmt.Fprintln(os.Stderr, "stream mode is tcp only")
		os.Exit(2)
	}
	if m == "openloop" && p != "udp" {
		fmt.Fprintln(os.Stderr, "openloop mode is udp only")
		os.Exit(2)
	}

	var res result
	var code int
	if p == "udp" {
		rate := *pps
		if rate <= 0 && *interval > 0 {
			rate = 1 / (*interval).Seconds()
		}
		if rate <= 0 {
			rate = 5
		}
		if m == "openloop" {
			res, code = runUDPOpen(*addr, *n, *par, *size, *timeout, *hold, rate)
		} else {
			res, code = runUDPRR(*addr, *n, *par, *size, *timeout, *hold, *interval, *probe)
		}
	} else {
		msg := []byte(*payload)
		if *size > 0 {
			msg = make([]byte, *size)
			for i := range msg {
				msg[i] = byte(i)
			}
		}
		if m == "stream" {
			res, code = runTCPStream(*addr, *n, *par, msg, *timeout, *hold)
		} else {
			res, code = runTCPRR(*addr, *n, *par, msg, *timeout, *hold, *interval, *probe)
		}
	}
	if *jsonPath != "" {
		raw, _ := json.MarshalIndent(res, "", "  ")
		_ = os.WriteFile(*jsonPath, raw, 0o644)
	}
	os.Exit(code)
}

func runEcho(tcpAddr, udpAddr string) {
	var wg sync.WaitGroup
	if tcpAddr != "" {
		ln, err := net.Listen("tcp", tcpAddr)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println("echo-tcp", ln.Addr())
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				c, err := ln.Accept()
				if err != nil {
					continue
				}
				go func(c net.Conn) {
					defer c.Close()
					_, _ = io.Copy(c, c)
				}(c)
			}
		}()
	}
	if udpAddr != "" {
		pc, err := net.ListenPacket("udp", udpAddr)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println("echo-udp", pc.LocalAddr())
		wg.Add(1)
		go func() {
			defer wg.Done()
			buf := make([]byte, 64*1024)
			for {
				n, raddr, err := pc.ReadFrom(buf)
				if err != nil {
					continue
				}
				_, _ = pc.WriteTo(buf[:n], raddr)
			}
		}()
	}
	wg.Wait()
}

type errBag struct {
	timeout, eof, rst, write, corrupt, other atomic.Int64
}

func (b *errBag) add(kind string) {
	switch kind {
	case "timeout":
		b.timeout.Add(1)
	case "eof":
		b.eof.Add(1)
	case "rst":
		b.rst.Add(1)
	case "write":
		b.write.Add(1)
	case "corrupt":
		b.corrupt.Add(1)
	default:
		b.other.Add(1)
	}
}

func (b *errBag) format() string {
	return fmt.Sprintf("timeout=%d eof=%d rst=%d write=%d corrupt=%d other=%d",
		b.timeout.Load(), b.eof.Load(), b.rst.Load(), b.write.Load(), b.corrupt.Load(), b.other.Load())
}

func isNetTimeout(err error) bool {
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

func holdOpEnded(deadline time.Time, timeout, to time.Duration, err error) bool {
	if !isNetTimeout(err) {
		return false
	}
	if !time.Now().Before(deadline) {
		return true
	}
	return to > 0 && to < timeout
}

func rrHoldOffset(i, n int, interval time.Duration) time.Duration {
	if interval <= 0 || n <= 0 {
		return 0
	}
	return time.Duration(i) * interval / time.Duration(n)
}

func rrSkipTicks(next time.Time, interval time.Duration, now time.Time) time.Time {
	if interval <= 0 {
		return now
	}
	n := next.Add(interval)
	for !n.After(now) {
		n = n.Add(interval)
	}
	return n
}

// rrNextDelay returns how long to wait before the next RR operation and
// whether another operation should be attempted. When the next scheduled
// operation falls at or beyond the hold deadline, it waits out the remaining
// hold window and tells the caller to stop. This prevents a tight retry loop in
// the final partial interval.
func rrNextDelay(opStarted, now, deadline time.Time, interval time.Duration) (time.Duration, bool) {
	if interval <= 0 {
		return 0, true
	}
	wait := interval - now.Sub(opStarted)
	if wait <= 0 {
		return 0, true
	}
	if !now.Add(wait).Before(deadline) {
		remain := deadline.Sub(now)
		if remain < 0 {
			remain = 0
		}
		return remain, false
	}
	return wait, true
}

func opTimeout(timeout time.Duration, deadline time.Time) time.Duration {
	remain := time.Until(deadline)
	const floor = 50 * time.Millisecond
	if remain < floor {
		return 0
	}
	if timeout < remain {
		return timeout
	}
	return remain
}

func runTCPRR(addr string, n, par int, msg []byte, timeout, hold, interval, probe time.Duration) (result, int) {
	fmt.Fprintf(os.Stderr, "tcp mode=rr closed-loop request/response interval=%s (0 means no extra sleep, still one req in flight)\n", interval)
	if interval > 0 {
		capBps := float64(n) * float64(len(msg)) * 2 / interval.Seconds()
		fmt.Fprintf(os.Stderr, "tcp rr generator cap ≈ %s/s bidir app echo (%d × %dB × 2 / %s); hold pings are staggered and skip missed ticks\n",
			bytesHuman(int64(capBps)), n, len(msg), interval)
	}
	var opened, firstFail, firstBytes atomic.Int64
	var holdAttempts, holdSuccess, holdErrors, holdBytes atomic.Int64
	var aliveAtDeadline, failedDuringHold, finalOK atomic.Int64
	var firstErrs, holdErrs errBag
	connectLat := make([]int64, n)
	echoLat := make([]int64, n)
	holdHits := make([]int64, n)
	var connectN, echoN, holdN atomic.Int64
	sem := make(chan struct{}, par)
	conns := make([]net.Conn, 0, n)
	var mu sync.Mutex
	t0 := time.Now()
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		sem <- struct{}{}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			d := net.Dialer{Timeout: timeout}
			tDial := time.Now()
			c, err := d.Dial("tcp", addr)
			if err != nil {
				firstFail.Add(1)
				firstErrs.add(classifyErr(err))
				return
			}
			if slot := connectN.Add(1) - 1; slot < int64(len(connectLat)) {
				connectLat[slot] = time.Since(tDial).Nanoseconds()
			}
			rbuf := make([]byte, len(msg))
			tEcho := time.Now()
			if err := echoTCPOnce(c, msg, rbuf, timeout); err != nil {
				firstFail.Add(1)
				firstErrs.add(classifyErr(err))
				_ = c.Close()
				return
			}
			if slot := echoN.Add(1) - 1; slot < int64(len(echoLat)) {
				echoLat[slot] = time.Since(tEcho).Nanoseconds()
			}
			firstBytes.Add(int64(len(msg)) * 2)
			opened.Add(1)
			mu.Lock()
			conns = append(conns, c)
			mu.Unlock()
		}()
	}
	wg.Wait()
	setupElapsed := time.Since(t0)
	fmt.Printf("tcp %s mode=rr setupElapsed=%s firstEchoOK=%d firstEchoTimeoutOrError=%d firstEchoBytes=%s\n",
		addr, setupElapsed.Round(time.Millisecond), opened.Load(), firstFail.Load(), bytesHuman(firstBytes.Load()))
	fmt.Printf("tcp %s firstErrs %s\n", addr, firstErrs.format())
	printLatency("tcp connect", connectLat[:min(int(connectN.Load()), len(connectLat))])
	printLatency("tcp firstEchoRTT", echoLat[:min(int(echoN.Load()), len(echoLat))])

	holdElapsed := time.Duration(0)
	if hold > 0 && len(conns) > 0 {
		fmt.Fprintf(os.Stderr, "tcp hold window %d conns × %dB interval=%s stagger=%v for %s\n",
			len(conns), len(msg), interval, interval > 0, hold)
		holdStart := time.Now()
		deadline := holdStart.Add(hold)
		nHold := len(conns)
		var xwg sync.WaitGroup
		alive := make([]atomic.Bool, nHold)
		for i := range conns {
			alive[i].Store(true)
			xwg.Add(1)
			go func(i int, c net.Conn) {
				defer xwg.Done()
				rbuf := make([]byte, len(msg))
				var hits int64
				next := holdStart.Add(rrHoldOffset(i, nHold, interval))
				for {
					now := time.Now()
					if !now.Before(deadline) {
						break
					}
					if interval > 0 && next.After(now) {
						wait := next.Sub(now)
						if !now.Add(wait).Before(deadline) {
							break
						}
						time.Sleep(wait)
						continue
					}
					to := opTimeout(timeout, deadline)
					if to == 0 {
						break
					}
					holdAttempts.Add(1)
					if err := echoTCPOnce(c, msg, rbuf, to); err != nil {
						_ = c.SetDeadline(time.Time{})
						if holdOpEnded(deadline, timeout, to, err) {
							break
						}
						holdErrors.Add(1)
						failedDuringHold.Add(1)
						holdErrs.add(classifyErr(err))
						alive[i].Store(false)
						_ = c.Close()
						break
					}
					_ = c.SetDeadline(time.Time{})
					holdSuccess.Add(1)
					hits++
					holdBytes.Add(int64(len(msg)) * 2)
					if interval > 0 {
						next = rrSkipTicks(next, interval, time.Now())
					}
				}
				if alive[i].Load() {
					aliveAtDeadline.Add(1)
				}
				if slot := holdN.Add(1) - 1; slot < int64(len(holdHits)) {
					holdHits[slot] = hits
				}
			}(i, conns[i])
		}
		xwg.Wait()
		holdElapsed = time.Since(holdStart)
		finalOK.Add(runFinalProbe(conns, alive, msg, probe, par, &holdErrs))
	}
	for _, c := range conns {
		_ = c.Close()
	}
	total := time.Since(t0)
	fmt.Printf("tcp %s holdElapsed=%s holdBytes=%s holdRate=%s/s\n",
		addr, holdElapsed.Round(time.Millisecond), bytesHuman(holdBytes.Load()), bytesHuman(rate(holdBytes.Load(), holdElapsed)))
	fmt.Printf("tcp %s holdAttempts=%d holdSuccess=%d holdErrors=%d aliveAtDeadline=%d failedDuringHold=%d finalProbeOK=%d\n",
		addr, holdAttempts.Load(), holdSuccess.Load(), holdErrors.Load(), aliveAtDeadline.Load(), failedDuringHold.Load(), finalOK.Load())
	fmt.Printf("tcp %s holdErrs %s\n", addr, holdErrs.format())
	printCounts("tcp hold echos/conn", holdHits[:min(int(holdN.Load()), len(holdHits))])
	fmt.Printf("tcp %s totalElapsed=%s\n", addr, total.Round(time.Millisecond))

	res := result{
		Proto: "tcp", Addr: addr, Mode: "rr", N: n, Size: len(msg),
		Interval: interval.String(), Timeout: timeout.String(), Hold: hold.String(),
		SetupElapsed: setupElapsed.Round(time.Millisecond).String(),
		FirstEchoOK:  opened.Load(), FirstEchoTimeoutOrError: firstFail.Load(), FirstEchoBytes: firstBytes.Load(),
		HoldElapsed: holdElapsed.Round(time.Millisecond).String(), HoldBytes: holdBytes.Load(),
		HoldRate:     bytesHuman(rate(holdBytes.Load(), holdElapsed)) + "/s",
		HoldAttempts: holdAttempts.Load(), HoldSuccess: holdSuccess.Load(), HoldErrors: holdErrors.Load(),
		AliveAtDeadline: aliveAtDeadline.Load(), FinalProbeOK: finalOK.Load(), FailedDuringHold: failedDuringHold.Load(),
		TotalElapsed: total.Round(time.Millisecond).String(),
	}
	code := 0
	if opened.Load() < int64(n) {
		code = 1
	}
	if hold > 0 && (aliveAtDeadline.Load() < opened.Load() || finalOK.Load() < opened.Load()) {
		code = 1
	}
	return res, code
}

func runTCPStream(addr string, n, par int, msg []byte, timeout, hold time.Duration) (result, int) {
	fmt.Fprintf(os.Stderr, "tcp mode=stream independent writer/reader with seq-prefixed chunks\n")
	if len(msg) < 16 {
		msg = make([]byte, 16)
	}
	sem := make(chan struct{}, par)
	conns := make([]net.Conn, 0, n)
	var mu sync.Mutex
	var opened, firstFail atomic.Int64
	t0 := time.Now()
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		sem <- struct{}{}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			c, err := net.DialTimeout("tcp", addr, timeout)
			if err != nil {
				firstFail.Add(1)
				return
			}
			opened.Add(1)
			mu.Lock()
			conns = append(conns, c)
			mu.Unlock()
		}()
	}
	wg.Wait()
	setupElapsed := time.Since(t0)
	fmt.Printf("tcp %s mode=stream setupElapsed=%s opened=%d dialFail=%d\n",
		addr, setupElapsed.Round(time.Millisecond), opened.Load(), firstFail.Load())

	var tx, rx, drain, txErr, rxErr, corrupt, aliveAt atomic.Int64
	txPer := make([]int64, len(conns))
	holdElapsed := time.Duration(0)
	drainElapsed := time.Duration(0)
	if hold > 0 && len(conns) > 0 {
		holdStart := time.Now()
		deadline := holdStart.Add(hold)
		var xwg sync.WaitGroup
		writerDone := make([]atomic.Bool, len(conns))
		readerOK := make([]atomic.Bool, len(conns))
		for i, c := range conns {
			xwg.Add(2)
			go func(i int, c net.Conn) {
				defer xwg.Done()
				buf := make([]byte, len(msg))
				var seq uint64
				for time.Now().Before(deadline) {
					to := opTimeout(timeout, deadline)
					if to == 0 {
						writerDone[i].Store(true)
						return
					}
					binary.BigEndian.PutUint64(buf[:8], seq)
					for j := 8; j < len(buf); j++ {
						buf[j] = byte(j) + byte(seq)
					}
					_ = c.SetWriteDeadline(time.Now().Add(to))
					nw, err := c.Write(buf)
					if nw > 0 {
						tx.Add(int64(nw))
						txPer[i] += int64(nw)
					}
					if err != nil || nw != len(buf) {
						if holdOpEnded(deadline, timeout, to, err) {
							writerDone[i].Store(true)
							return
						}
						txErr.Add(1)
						return
					}
					seq++
				}
				writerDone[i].Store(true)
			}(i, c)
			go func(i int, c net.Conn) {
				defer xwg.Done()
				buf := make([]byte, len(msg))
				var expect uint64
				for time.Now().Before(deadline) {
					to := opTimeout(timeout, deadline)
					if to == 0 {
						readerOK[i].Store(true)
						return
					}
					_ = c.SetReadDeadline(time.Now().Add(to))
					_, err := io.ReadFull(c, buf)
					if err != nil {
						if holdOpEnded(deadline, timeout, to, err) {
							readerOK[i].Store(true)
							return
						}
						rxErr.Add(1)
						return
					}
					got := binary.BigEndian.Uint64(buf[:8])
					bad := got != expect
					if !bad {
						for j := 8; j < len(buf); j++ {
							if buf[j] != byte(j)+byte(got) {
								bad = true
								break
							}
						}
					}
					if bad {
						corrupt.Add(1)
						rxErr.Add(1)
						return
					}
					rx.Add(int64(len(buf)))
					expect++
				}
				readerOK[i].Store(true)
			}(i, c)
		}
		xwg.Wait()
		holdElapsed = time.Since(holdStart)
		for i := range conns {
			if writerDone[i].Load() && readerOK[i].Load() {
				aliveAt.Add(1)
			}
		}
		tDrain := time.Now()
		drainDeadline := tDrain.Add(timeout)
		var dwg sync.WaitGroup
		for _, c := range conns {
			if tc, ok := c.(*net.TCPConn); ok {
				_ = tc.CloseWrite()
			}
			dwg.Add(1)
			go func(c net.Conn) {
				defer dwg.Done()
				_ = c.SetReadDeadline(drainDeadline)
				buf := make([]byte, len(msg))
				for time.Now().Before(drainDeadline) {
					n, err := c.Read(buf)
					if n > 0 {
						drain.Add(int64(n))
					}
					if err != nil {
						return
					}
				}
			}(c)
		}
		dwg.Wait()
		drainElapsed = time.Since(tDrain)
	}
	for _, c := range conns {
		_ = c.Close()
	}
	total := time.Since(t0)
	inflight := tx.Load() - rx.Load()
	if inflight < 0 {
		inflight = 0
	}
	bidir := tx.Load() + rx.Load()
	fmt.Printf("tcp %s holdElapsed=%s tx=%s rx=%s txRate=%s/s rxRate=%s/s bidirRate=%s/s\n",
		addr, holdElapsed.Round(time.Millisecond),
		bytesHuman(tx.Load()), bytesHuman(rx.Load()),
		bytesHuman(rate(tx.Load(), holdElapsed)), bytesHuman(rate(rx.Load(), holdElapsed)),
		bytesHuman(rate(bidir, holdElapsed)))
	fmt.Printf("tcp %s txErr=%d rxErr=%d corrupt=%d aliveAtDeadline=%d inflight=%s drainBytes=%s drainElapsed=%s\n",
		addr, txErr.Load(), rxErr.Load(), corrupt.Load(), aliveAt.Load(),
		bytesHuman(inflight), bytesHuman(drain.Load()), drainElapsed.Round(time.Millisecond))
	printCounts("tcp stream tx/conn", txPer)
	fmt.Printf("tcp %s totalElapsed=%s\n", addr, total.Round(time.Millisecond))
	res := result{
		Proto: "tcp", Addr: addr, Mode: "stream", N: n, Size: len(msg),
		Timeout: timeout.String(), Hold: hold.String(),
		SetupElapsed: setupElapsed.Round(time.Millisecond).String(),
		FirstEchoOK:  opened.Load(), FirstEchoTimeoutOrError: firstFail.Load(),
		HoldElapsed: holdElapsed.Round(time.Millisecond).String(),
		HoldBytes:   bidir, HoldRate: bytesHuman(rate(bidir, holdElapsed)) + "/s",
		HoldTx: tx.Load(), HoldRx: rx.Load(),
		HoldTxRate: bytesHuman(rate(tx.Load(), holdElapsed)) + "/s",
		HoldRxRate: bytesHuman(rate(rx.Load(), holdElapsed)) + "/s",
		TxErr:      txErr.Load(), RxErr: rxErr.Load(),
		AliveAtDeadline: aliveAt.Load(), Inflight: inflight,
		DrainBytes: drain.Load(), DrainElapsed: drainElapsed.Round(time.Millisecond).String(),
		TotalElapsed: total.Round(time.Millisecond).String(),
	}
	code := 0
	if opened.Load() < int64(n) || txErr.Load() > 0 || rxErr.Load() > 0 || corrupt.Load() > 0 {
		code = 1
	}
	return res, code
}

func runUDPRR(addr string, n, par, size int, timeout, hold, interval, probe time.Duration) (result, int) {
	total := clampUDPSize(size)
	body := total - udpHeaderLen
	fmt.Fprintf(os.Stderr, "udp mode=rr closed-loop; timeout blocks sender (adaptive backoff)\n")
	printUDPCap(n, total, interval)
	var bound, firstOK, firstFail, firstBytes atomic.Int64
	var attempts, success, timeouts, late, dup, ooo, corrupt, holdBytes atomic.Int64
	var flowSeq atomic.Uint32
	sem := make(chan struct{}, par)
	flows := make([]*udpFlow, 0, n)
	var mu sync.Mutex
	t0 := time.Now()
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		sem <- struct{}{}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			c, err := net.DialTimeout("udp", addr, timeout)
			if err != nil {
				firstFail.Add(1)
				return
			}
			f := newUDPFlow(c, flowSeq.Add(1), total)
			bound.Add(1)
			st := udpRROnce(f, body, timeout, &late, &dup, &ooo, &corrupt)
			attempts.Add(1)
			switch st {
			case "ok":
				firstOK.Add(1)
				success.Add(1)
				firstBytes.Add(int64(total) * 2)
			case "timeout":
				firstFail.Add(1)
				timeouts.Add(1)
			default:
				firstFail.Add(1)
				corrupt.Add(1)
			}
			mu.Lock()
			flows = append(flows, f)
			mu.Unlock()
		}()
	}
	wg.Wait()
	setupElapsed := time.Since(t0)
	fmt.Printf("udp %s mode=rr setupElapsed=%s bound=%d firstEchoOK=%d firstEchoTimeoutOrError=%d firstEchoBytes=%s\n",
		addr, setupElapsed.Round(time.Millisecond), bound.Load(), firstOK.Load(), firstFail.Load(), bytesHuman(firstBytes.Load()))

	holdElapsed := time.Duration(0)
	if hold > 0 && len(flows) > 0 {
		holdStart := time.Now()
		deadline := holdStart.Add(hold)
		var xwg sync.WaitGroup
		for _, f := range flows {
			xwg.Add(1)
			go func(f *udpFlow) {
				defer xwg.Done()
				for time.Now().Before(deadline) {
					tEcho := time.Now()
					st := udpRROnce(f, body, opTimeout(timeout, deadline), &late, &dup, &ooo, &corrupt)
					attempts.Add(1)
					switch st {
					case "ok":
						success.Add(1)
						holdBytes.Add(int64(total) * 2)
					case "timeout":
						timeouts.Add(1)
					default:
						corrupt.Add(1)
					}
					if wait, again := rrNextDelay(tEcho, time.Now(), deadline, interval); wait > 0 || !again {
						if wait > 0 {
							time.Sleep(wait)
						}
						if !again {
							break
						}
					}
				}
			}(f)
		}
		xwg.Wait()
		holdElapsed = time.Since(holdStart)
		_ = probe
	}
	for _, f := range flows {
		_ = f.c.Close()
	}
	wall := time.Since(t0)
	printUDPStats(addr, "rr", attempts.Load(), success.Load(), timeouts.Load(), late.Load(), dup.Load(), ooo.Load(), corrupt.Load())
	fmt.Printf("udp %s holdElapsed=%s holdBytes=%s holdRate=%s/s totalElapsed=%s\n",
		addr, holdElapsed.Round(time.Millisecond), bytesHuman(holdBytes.Load()),
		bytesHuman(rate(holdBytes.Load(), holdElapsed)), wall.Round(time.Millisecond))
	res := result{
		Proto: "udp", Addr: addr, Mode: "rr", N: n, Size: total,
		Interval: interval.String(), Timeout: timeout.String(), Hold: hold.String(),
		SetupElapsed: setupElapsed.Round(time.Millisecond).String(),
		FirstEchoOK:  firstOK.Load(), FirstEchoTimeoutOrError: firstFail.Load(), FirstEchoBytes: firstBytes.Load(),
		HoldElapsed: holdElapsed.Round(time.Millisecond).String(), HoldBytes: holdBytes.Load(),
		HoldRate: bytesHuman(rate(holdBytes.Load(), holdElapsed)) + "/s",
		UDPSent:  attempts.Load(), UDPRecv: success.Load(), UDPTimeout: timeouts.Load(),
		UDPLate: late.Load(), UDPDup: dup.Load(), UDPOOO: ooo.Load(), UDPCorrupt: corrupt.Load(),
		TotalElapsed: wall.Round(time.Millisecond).String(),
	}
	if attempts.Load() > 0 {
		res.UDPLossRate = float64(timeouts.Load()) / float64(attempts.Load())
	}
	return res, 0
}

func runUDPOpen(addr string, n, par, size int, timeout, hold time.Duration, pps float64) (result, int) {
	total := clampUDPSize(size)
	body := total - udpHeaderLen
	fmt.Fprintf(os.Stderr, "udp mode=openloop pps=%.3f/flow sender independent of receiver\n", pps)
	var bound, firstFail atomic.Int64
	var sent, recv, holdRecv, graceRecv, late, dup, ooo, corrupt, rttN, rttSum atomic.Int64
	var flowSeq atomic.Uint32
	sem := make(chan struct{}, par)
	flows := make([]*udpFlow, 0, n)
	var mu sync.Mutex
	t0 := time.Now()
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		sem <- struct{}{}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			c, err := net.DialTimeout("udp", addr, timeout)
			if err != nil {
				firstFail.Add(1)
				return
			}
			f := newUDPFlow(c, flowSeq.Add(1), total)
			bound.Add(1)
			mu.Lock()
			flows = append(flows, f)
			mu.Unlock()
		}()
	}
	wg.Wait()
	setupElapsed := time.Since(t0)
	fmt.Printf("udp %s mode=openloop setupElapsed=%s bound=%d dialFail=%d pps=%.3f\n",
		addr, setupElapsed.Round(time.Millisecond), bound.Load(), firstFail.Load(), pps)

	holdElapsed := time.Duration(0)
	if hold > 0 && len(flows) > 0 {
		holdStart := time.Now()
		deadline := holdStart.Add(hold)
		grace := deadline.Add(timeout)
		period := time.Duration(float64(time.Second) / pps)
		if period < time.Millisecond {
			period = time.Millisecond
		}
		var sendWG, recvWG sync.WaitGroup
		for _, f := range flows {
			sendWG.Add(1)
			recvWG.Add(1)
			go func(f *udpFlow) {
				defer sendWG.Done()
				// Random initial phase so N flows do not emit a synchronized microburst.
				if period > 0 {
					time.Sleep(time.Duration(rand.Int63n(int64(period))))
				}
				tick := time.NewTicker(period)
				defer tick.Stop()
				for time.Now().Before(deadline) {
					seq := f.seq.Add(1)
					now := time.Now().UnixNano()
					encodeUDP(f.wbuf, f.id, seq, uint64(now), body)
					_ = f.c.SetWriteDeadline(time.Now().Add(opTimeout(timeout, deadline)))
					if _, err := f.c.Write(f.wbuf); err != nil {
						return
					}
					sent.Add(1)
					<-tick.C
				}
			}(f)
			go func(f *udpFlow) {
				defer recvWG.Done()
				const seqWin = 8192
				seen := map[uint64]struct{}{}
				var maxSeq uint64
				for time.Now().Before(grace) {
					_ = f.c.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
					n, err := f.c.Read(f.rbuf)
					if err != nil {
						continue
					}
					flow, seq, ts, payload, ok := parseUDP(f.rbuf[:n])
					if !ok || flow != f.id {
						corrupt.Add(1)
						continue
					}
					bad := len(payload) != body
					if !bad {
						for i, b := range payload {
							if b != byte(i) {
								bad = true
								break
							}
						}
					}
					if bad {
						corrupt.Add(1)
						continue
					}
					if maxSeq > seqWin && seq+seqWin < maxSeq {
						late.Add(1)
						continue
					}
					if _, hit := seen[seq]; hit {
						dup.Add(1)
						continue
					}
					seen[seq] = struct{}{}
					if seq < maxSeq {
						ooo.Add(1)
					}
					if seq > maxSeq {
						maxSeq = seq
						if seq%256 == 0 {
							cut := seq - seqWin
							for k := range seen {
								if k < cut {
									delete(seen, k)
								}
							}
						}
					}
					recv.Add(1)
					if time.Now().Before(deadline) {
						holdRecv.Add(1)
					} else {
						graceRecv.Add(1)
						late.Add(1)
					}
					if ts > 0 {
						rtt := time.Now().UnixNano() - int64(ts)
						if rtt > 0 {
							rttSum.Add(rtt)
							rttN.Add(1)
						}
					}
				}
			}(f)
		}
		sendWG.Wait()
		holdElapsed = time.Since(holdStart)
		recvWG.Wait()
	}
	for _, f := range flows {
		_ = f.c.Close()
	}
	wall := time.Since(t0)
	loss := sent.Load() - recv.Load()
	if loss < 0 {
		loss = 0
	}
	fmt.Printf("udp %s openloop sent=%d recv=%d holdRecv=%d graceRecv=%d loss=%d dup=%d ooo=%d corrupt=%d\n",
		addr, sent.Load(), recv.Load(), holdRecv.Load(), graceRecv.Load(), loss, dup.Load(), ooo.Load(), corrupt.Load())
	if sent.Load() > 0 {
		fmt.Printf("udp %s deliveryRate=%.4f holdDelivery=%.4f lossRate=%.4f sendRate=%s/s holdRecvRate=%s/s\n",
			addr, float64(recv.Load())/float64(sent.Load()), float64(holdRecv.Load())/float64(sent.Load()),
			float64(loss)/float64(sent.Load()),
			bytesHuman(rate(sent.Load()*int64(total), holdElapsed)),
			bytesHuman(rate(holdRecv.Load()*int64(total), holdElapsed)))
	}
	if rttN.Load() > 0 {
		fmt.Printf("udp %s rttMean=%s\n", addr, time.Duration(rttSum.Load()/rttN.Load()).Round(time.Microsecond))
	}
	fmt.Printf("udp %s holdElapsed=%s totalElapsed=%s\n", addr, holdElapsed.Round(time.Millisecond), wall.Round(time.Millisecond))
	res := result{
		Proto: "udp", Addr: addr, Mode: "openloop", N: n, Size: total,
		Timeout: timeout.String(), Hold: hold.String(),
		SetupElapsed: setupElapsed.Round(time.Millisecond).String(),
		FirstEchoOK:  bound.Load(), FirstEchoTimeoutOrError: firstFail.Load(),
		HoldElapsed: holdElapsed.Round(time.Millisecond).String(),
		HoldBytes:   holdRecv.Load() * int64(total),
		HoldRate:    bytesHuman(rate(holdRecv.Load()*int64(total), holdElapsed)) + "/s",
		UDPSent:     sent.Load(), UDPRecv: recv.Load(), UDPHoldRecv: holdRecv.Load(), UDPGraceRecv: graceRecv.Load(),
		UDPTimeout: loss, UDPLate: late.Load(), UDPDup: dup.Load(), UDPOOO: ooo.Load(), UDPCorrupt: corrupt.Load(),
		TotalElapsed: wall.Round(time.Millisecond).String(),
	}
	if sent.Load() > 0 {
		res.UDPLossRate = float64(loss) / float64(sent.Load())
	}
	return res, 0
}

func runFinalProbe(conns []net.Conn, alive []atomic.Bool, msg []byte, probe time.Duration, par int, holdErrs *errBag) int64 {
	if par < 1 {
		par = 1
	}
	deadline := time.Now().Add(probe)
	sem := make(chan struct{}, par)
	var ok atomic.Int64
	var wg sync.WaitGroup
	for i, c := range conns {
		if !alive[i].Load() {
			continue
		}
		wg.Add(1)
		go func(c net.Conn) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			remain := time.Until(deadline)
			if remain <= 0 {
				return
			}
			rbuf := make([]byte, len(msg))
			if err := echoTCPOnce(c, msg, rbuf, remain); err != nil {
				if !isNetTimeout(err) || time.Now().Before(deadline) {
					holdErrs.add(classifyErr(err))
				}
				return
			}
			ok.Add(1)
		}(c)
	}
	wg.Wait()
	return ok.Load()
}

func newUDPFlow(c net.Conn, id uint32, total int) *udpFlow {
	return &udpFlow{c: c, id: id, wbuf: make([]byte, total), rbuf: make([]byte, total+64)}
}

func clampUDPSize(size int) int {
	total := size
	if total <= 0 {
		total = udpSafeTotal
	}
	if total < udpHeaderLen+8 {
		total = udpHeaderLen + 8
	}
	if total > udpSafeTotal {
		fmt.Fprintf(os.Stderr, "udp size %d clamped to %d\n", total, udpSafeTotal)
		total = udpSafeTotal
	}
	return total
}

func printUDPCap(n, total int, interval time.Duration) {
	if interval <= 0 || n <= 0 {
		return
	}
	capBps := float64(n) * float64(total) * 2 / interval.Seconds()
	fmt.Fprintf(os.Stderr, "udp rr generator cap ≈ %s/s bidir app echo (%d × %dB × 2 / %s)\n",
		bytesHuman(int64(capBps)), n, total, interval)
}

func printUDPStats(addr, mode string, attempts, success, timeouts, late, dup, ooo, corrupt int64) {
	fmt.Printf("udp %s mode=%s attempts=%d success=%d timeout=%d late=%d dup=%d ooo=%d corrupt=%d\n",
		addr, mode, attempts, success, timeouts, late, dup, ooo, corrupt)
	if attempts > 0 {
		fmt.Printf("udp %s successRate=%.4f timeoutRate=%.4f\n",
			addr, float64(success)/float64(attempts), float64(timeouts)/float64(attempts))
	}
}

func encodeUDP(buf []byte, flow uint32, seq, sent uint64, body int) {
	copy(buf[0:4], udpMagic)
	binary.BigEndian.PutUint32(buf[4:8], flow)
	binary.BigEndian.PutUint64(buf[8:16], seq)
	binary.BigEndian.PutUint64(buf[16:24], sent)
	for i := 0; i < body && 24+i < len(buf); i++ {
		buf[24+i] = byte(i)
	}
}

func parseUDP(buf []byte) (flow uint32, seq, sent uint64, body []byte, ok bool) {
	if len(buf) < udpHeaderLen || string(buf[0:4]) != udpMagic {
		return 0, 0, 0, nil, false
	}
	flow = binary.BigEndian.Uint32(buf[4:8])
	seq = binary.BigEndian.Uint64(buf[8:16])
	sent = binary.BigEndian.Uint64(buf[16:24])
	return flow, seq, sent, buf[24:], true
}

func udpRROnce(f *udpFlow, body int, timeout time.Duration, late, dup, ooo, corrupt *atomic.Int64) string {
	want := f.seq.Add(1)
	sent := uint64(time.Now().UnixNano())
	encodeUDP(f.wbuf, f.id, want, sent, body)
	_ = f.c.SetWriteDeadline(time.Now().Add(timeout))
	if _, err := f.c.Write(f.wbuf); err != nil {
		return "timeout"
	}
	deadline := time.Now().Add(timeout)
	seen := map[uint64]struct{}{}
	for {
		remain := time.Until(deadline)
		if remain <= 0 {
			return "timeout"
		}
		_ = f.c.SetReadDeadline(time.Now().Add(remain))
		n, err := f.c.Read(f.rbuf)
		if err != nil {
			return "timeout"
		}
		flow, seq, _, payload, ok := parseUDP(f.rbuf[:n])
		if !ok || flow != f.id {
			corrupt.Add(1)
			continue
		}
		if seq < want {
			if _, hit := seen[seq]; hit {
				dup.Add(1)
			} else {
				late.Add(1)
				seen[seq] = struct{}{}
			}
			continue
		}
		if seq > want {
			ooo.Add(1)
			continue
		}
		expect := f.wbuf[24:]
		if len(payload) != len(expect) || !bytes.Equal(payload, expect) {
			corrupt.Add(1)
			continue
		}
		return "ok"
	}
}

func echoTCPOnce(c net.Conn, msg, rbuf []byte, timeout time.Duration) error {
	_ = c.SetDeadline(time.Now().Add(timeout))
	if _, err := c.Write(msg); err != nil {
		return err
	}
	if len(rbuf) < len(msg) {
		rbuf = make([]byte, len(msg))
	}
	if _, err := io.ReadFull(c, rbuf[:len(msg)]); err != nil {
		return err
	}
	if !bytes.Equal(rbuf[:len(msg)], msg) {
		return errCorrupt
	}
	return nil
}

func classifyErr(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, errCorrupt) {
		return "corrupt"
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return "timeout"
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return "eof"
	}
	if errors.Is(err, syscall.ECONNRESET) {
		return "rst"
	}
	var op *net.OpError
	if errors.As(err, &op) {
		if op.Err != nil {
			if errors.Is(op.Err, syscall.ECONNRESET) {
				return "rst"
			}
			var ne2 net.Error
			if errors.As(op.Err, &ne2) && ne2.Timeout() {
				return "timeout"
			}
		}
		if op.Op == "write" {
			return "write"
		}
	}
	s := strings.ToLower(err.Error())
	switch {
	case strings.Contains(s, "reset"):
		return "rst"
	case strings.Contains(s, "broken pipe"):
		return "write"
	case strings.Contains(s, "timeout"):
		return "timeout"
	default:
		return "other"
	}
}

func printLatency(label string, ns []int64) {
	if len(ns) == 0 {
		return
	}
	s := append([]int64(nil), ns...)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	fmt.Printf("%s n=%d min=%s p50=%s p95=%s p99=%s max=%s\n",
		label, len(s), dur(s[0]), dur(pct(s, 0.50)), dur(pct(s, 0.95)), dur(pct(s, 0.99)), dur(s[len(s)-1]))
}

func printCounts(label string, v []int64) {
	if len(v) == 0 {
		return
	}
	s := append([]int64(nil), v...)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	fmt.Printf("%s n=%d min=%d p50=%d p95=%d p99=%d max=%d\n",
		label, len(s), s[0], pct(s, 0.50), pct(s, 0.95), pct(s, 0.99), s[len(s)-1])
}

func pct(sorted []int64, p float64) int64 {
	if len(sorted) == 0 {
		return 0
	}
	i := int(float64(len(sorted)-1) * p)
	if i < 0 {
		i = 0
	}
	if i >= len(sorted) {
		i = len(sorted) - 1
	}
	return sorted[i]
}

func dur(ns int64) string { return time.Duration(ns).Round(time.Microsecond).String() }

func rate(n int64, d time.Duration) int64 {
	sec := d.Seconds()
	if sec <= 0 {
		return 0
	}
	return int64(float64(n) / sec)
}

func bytesHuman(n int64) string {
	f := float64(n)
	switch {
	case n >= 1<<30:
		return fmt.Sprintf("%.2fGiB", f/(1<<30))
	case n >= 1<<20:
		return fmt.Sprintf("%.2fMiB", f/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.1fKiB", f/(1<<10))
	default:
		return fmt.Sprintf("%dB", n)
	}
}
