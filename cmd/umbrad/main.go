package main

import (
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/pprof"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"time"

	"umbra/internal/control"
	"umbra/internal/gate"
	"umbra/internal/netutil"
	"umbra/internal/obs"
	"umbra/internal/stealth"
	"umbra/internal/tlscfg"
)

func main() {
	listen := flag.String("listen", ":4400", "节点控制通道")
	advertise := flag.String("advertise", envOr("UMBRA_ADVERTISE", ""), "节点和访客可连接的对外地址 host:port；空则沿用 listen")
	httpAddr := flag.String("http", "127.0.0.1:8080", "控制台与 API 同一 HTTP 口，默认只绑回环")
	api := flag.String("api", "", "兼容旧参数，覆盖 -http")
	httpTLS := flag.Bool("http-tls", false, "管理口使用 tls-dir 里的 gate 证书")
	httpCert := flag.String("http-tls-cert", envOr("UMBRA_HTTP_TLS_CERT", ""), "管理口证书，非回环必须")
	httpKey := flag.String("http-tls-key", envOr("UMBRA_HTTP_TLS_KEY", ""), "管理口私钥")
	httpTrust := flag.String("http-trust-proxy", envOr("UMBRA_HTTP_TRUST_PROXY", ""), "可信反代 CIDR，才信 X-Forwarded-Proto")
	ui := flag.String("ui", "", "前端静态目录，空则用内置")
	bind := flag.String("bind", "127.0.0.1", "入口监听地址")
	tlsDir := flag.String("tls-dir", "/var/lib/umbra", "证书与热升级状态")
	plain := flag.Bool("plain", false, "控制通道不加密（仅调试）")
	stealthMode := flag.String("stealth", "auto", "nft | off | auto")
	udpMode := flag.String("udp", envOr("UMBRA_UDP", "auto"), "UDP 数据面: auto | required | yamux")
	stateFile := flag.String("state", "", "热升级恢复的状态文件")
	pprofAddr := flag.String("pprof", envOr("UMBRA_PPROF", "off"), "pprof 监听，默认关闭；只允许回环或 Unix")
	flag.Parse()
	obs.Init()

	if err := os.MkdirAll(*tlsDir, 0o700); err != nil {
		log.Fatal(err)
	}
	bundle, err := tlscfg.Ensure(*tlsDir)
	if err != nil {
		log.Fatal(err)
	}

	st := stealth.New(*stealthMode != "off")
	s := gate.New(*bind, st)
	s.SetUDPMode(gate.ParseUDPMode(*udpMode))
	if !*plain {
		s.SetTLS(bundle.TLS.Clone())
	}

	if *stateFile == "" {
		*stateFile = filepath.Join(*tlsDir, "state.json")
	}
	var snap gate.Snapshot
	upgraded := os.Getenv("UMBRA_UPGRADED") == "1"
	if upgraded {
		if raw, err := os.ReadFile(*stateFile); err == nil {
			_ = json.Unmarshal(raw, &snap)
			if err := s.RestoreTokens(snap.Tokens); err != nil {
				log.Printf("upgrade: %v", err)
			} else {
				log.Printf("upgrade: tokens restored")
			}
		}
	}

	cln, err := netutil.Listen("tcp", *listen)
	if err != nil {
		log.Fatal(err)
	}
	if upc, err := netutil.ListenPacket("udp", *listen); err != nil {
		if gate.ParseUDPMode(*udpMode) == gate.UDPRequired {
			log.Fatalf("udp data plane listen %s: %v", *listen, err)
		}
		log.Printf("udp data plane listen %s: %v — UDP will fall back to yamux", *listen, err)
	} else {
		if err := netutil.SetUDPReadBuffer(upc); err != nil {
			_ = upc.Close()
			if gate.ParseUDPMode(*udpMode) == gate.UDPRequired {
				log.Fatalf("udp data plane read buffer: %v", err)
			}
			log.Printf("udp data plane read buffer: %v — UDP will fall back to yamux", err)
		} else {
			s.AttachUPlane(upc)
		}
	}
	apiAddr := *httpAddr
	if *api != "" {
		apiAddr = *api
	}
	certFile, keyFile := *httpCert, *httpKey
	if *httpTLS {
		if certFile == "" {
			certFile = filepath.Join(*tlsDir, "gate.crt")
		}
		if keyFile == "" {
			keyFile = filepath.Join(*tlsDir, "gate.key")
		}
	}
	hasHTTPTLS := certFile != "" && keyFile != ""
	if err := control.CheckHTTPBind(apiAddr, hasHTTPTLS); err != nil {
		log.Fatal(err)
	}
	aln, err := listenAPI(apiAddr)
	if err != nil {
		log.Fatal(err)
	}
	s.SetListeners(cln, aln)

	nodeAddr := *advertise
	if nodeAddr == "" {
		nodeAddr = *listen
	}
	if strings.HasPrefix(nodeAddr, ":") {
		nodeAddr = "127.0.0.1" + nodeAddr
	}
	con, err := control.New(s, filepath.Join(*tlsDir, "control.json"))
	if err != nil {
		log.Fatal(err)
	}
	con.Listen = nodeAddr
	con.CAFile = bundle.CAFile
	con.NodeBin = envOr("UMBRA_NODE_BIN", "/usr/local/bin/umbra-node")
	con.UIDir = *ui
	con.UIUpstream = os.Getenv("UMBRA_UI_UPSTREAM")
	if con.UIUpstream == "" && os.Getenv("GROK_AGENT") != "" {
		con.UIUpstream = "http://127.0.0.1:8080"
	}
	con.SkipAuth = os.Getenv("UMBRA_LOGIN") == "off" || os.Getenv("GROK_AGENT") != "" || os.Getenv("GROK_PROJECT_ID") != ""
	con.TrustProxy = *httpTrust

	mode := "tls1.3"
	if *plain {
		mode = "plain"
	}
	httpMode := "http"
	if hasHTTPTLS {
		httpMode = "https"
	}
	log.Printf("umbrad control %s (%s) %s %s entry-bind %s stealth %s udp %s ca %s", *listen, mode, httpMode, apiAddr, *bind, st.Mode(), s.Status().UDP, bundle.CAFile)

	if *pprofAddr != "" && *pprofAddr != "off" {
		if control.HTTPBindNeedsTLS(*pprofAddr) {
			log.Fatal("pprof 只允许回环或 Unix socket")
		}
		go servePprof(*pprofAddr)
	}
	go func() {
		if err := s.ServeControl(cln); err != nil {
			log.Printf("control: %v", err)
		}
	}()
	go func() {
		srv := control.NewHTTPServer(con.Handler())
		var err error
		if hasHTTPTLS {
			if srv.TLSConfig == nil {
				srv.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS13}
			}
			err = srv.ServeTLS(aln, certFile, keyFile)
		} else {
			err = srv.Serve(aln)
		}
		if err != nil {
			log.Printf("http: %v", err)
		}
	}()

	if upgraded {
		s.Restore(snap)
		log.Printf("upgrade: entries restored pid %d", os.Getpid())
	}

	ch := make(chan os.Signal, 1)
	signal.Notify(ch, watchSignals()...)
	for sig := range ch {
		if isUpgrade(sig) {
			log.Printf("upgrade: releasing listeners then spawning replacement")
			raw, _ := json.Marshal(s.Snapshot())
			_ = os.WriteFile(*stateFile, raw, 0o600)
			s.StopAccept()
			cmd := exec.Command(os.Args[0], os.Args[1:]...)
			logf, err := os.OpenFile(filepath.Join(*tlsDir, "upgrade.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
			if err == nil {
				cmd.Stdout = logf
				cmd.Stderr = logf
			} else {
				cmd.Stdout = os.Stdout
				cmd.Stderr = os.Stderr
			}
			nonce := fmt.Sprintf("%d", time.Now().UnixNano())
			cmd.Env = append(os.Environ(), "UMBRA_UPGRADED=1", "UMBRA_UPGRADE_NONCE="+nonce)
			if err := cmd.Start(); err != nil {
				log.Printf("upgrade spawn: %v", err)
				os.Exit(1)
			}
			s.WaitIdle(3 * time.Second)
			con.FlushTraffic()
			log.Printf("upgrade: old pid %d exiting, replacement pid %d", os.Getpid(), cmd.Process.Pid)
			os.Exit(0)
		}
		s.StopAccept()
		s.WaitIdle(3 * time.Second)
		con.FlushTraffic()
		st.Clear()
		return
	}
}

func listenAPI(addr string) (net.Listener, error) {
	if strings.Contains(addr, "/") || strings.HasSuffix(addr, ".sock") || strings.HasPrefix(addr, "unix:") {
		path := strings.TrimPrefix(addr, "unix:")
		_ = os.Remove(path)
		ln, err := net.Listen("unix", path)
		if err != nil {
			return nil, err
		}
		_ = os.Chmod(path, 0o600)
		return ln, nil
	}
	return net.Listen("tcp", addr)
}

func servePprof(addr string) {
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Printf("pprof %s: %v", addr, err)
		return
	}
	log.Printf("pprof %s", ln.Addr())
	_ = http.Serve(ln, mux)
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
