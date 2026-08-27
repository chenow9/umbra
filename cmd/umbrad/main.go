package main

import (
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"time"

	"umbra/internal/control"
	"umbra/internal/gate"
	"umbra/internal/netutil"
	"umbra/internal/stealth"
	"umbra/internal/tlscfg"
)

func main() {
	listen := flag.String("listen", ":4400", "节点控制通道")
	httpAddr := flag.String("http", ":8080", "控制台与 API 同一 HTTP 口")
	api := flag.String("api", "", "兼容旧参数，覆盖 -http")
	ui := flag.String("ui", "", "前端静态目录，空则用内置")
	bind := flag.String("bind", "127.0.0.1", "入口监听地址")
	tlsDir := flag.String("tls-dir", "/var/lib/umbra", "证书与热升级状态")
	plain := flag.Bool("plain", false, "控制通道不加密（仅调试）")
	stealthMode := flag.String("stealth", "auto", "nft | off | auto")
	stateFile := flag.String("state", "", "热升级恢复的状态文件")
	flag.Parse()

	if err := os.MkdirAll(*tlsDir, 0o700); err != nil {
		log.Fatal(err)
	}
	bundle, err := tlscfg.Ensure(*tlsDir)
	if err != nil {
		log.Fatal(err)
	}

	st := stealth.New(*stealthMode != "off")
	s := gate.New(*bind, st)

	if *stateFile == "" {
		*stateFile = filepath.Join(*tlsDir, "state.json")
	}
	var snap gate.Snapshot
	upgraded := os.Getenv("UMBRA_UPGRADED") == "1"
	nonce := os.Getenv("UMBRA_UPGRADE_NONCE")
	if upgraded {
		if raw, err := os.ReadFile(*stateFile); err == nil {
			_ = json.Unmarshal(raw, &snap)
			s.RestoreTokens(snap.Tokens)
			log.Printf("upgrade: tokens restored, waiting to take entries")
		}
	}

	cln, err := netutil.Listen("tcp", *listen)
	if err != nil {
		log.Fatal(err)
	}
	if !*plain {
		cln = tls.NewListener(cln, bundle.TLS.Clone())
	}
	apiAddr := *httpAddr
	if *api != "" {
		apiAddr = *api
	}
	aln, err := listenAPI(apiAddr)
	if err != nil {
		log.Fatal(err)
	}
	s.SetListeners(cln, aln)

	agentAddr := *listen
	if strings.HasPrefix(agentAddr, ":") {
		agentAddr = "127.0.0.1" + agentAddr
	}
	con := control.New(s, filepath.Join(*tlsDir, "control.json"))
	con.Listen = agentAddr
	con.CAFile = bundle.CAFile
	con.AgentBin = envOr("UMBRA_AGENT_BIN", "/usr/local/bin/umbra-agent")
	con.UIDir = *ui
	con.UIUpstream = os.Getenv("UMBRA_UI_UPSTREAM")
	if con.UIUpstream == "" && os.Getenv("GROK_AGENT") != "" {
		con.UIUpstream = "http://127.0.0.1:8080"
	}
	con.SkipAuth = os.Getenv("UMBRA_LOGIN") == "off" || os.Getenv("GROK_AGENT") != "" || os.Getenv("GROK_PROJECT_ID") != ""

	mode := "tls1.3"
	if *plain {
		mode = "plain"
	}
	log.Printf("umbrad control %s (%s) http %s entry-bind %s stealth %s ca %s", *listen, mode, apiAddr, *bind, st.Mode(), bundle.CAFile)

	go func() {
		if err := s.ServeControl(cln); err != nil {
			log.Printf("control: %v", err)
		}
	}()
	go func() {
		if err := http.Serve(aln, con.Handler()); err != nil {
			log.Printf("http: %v", err)
		}
	}()

	if upgraded {
		takeover := filepath.Join(*tlsDir, "takeover")
		ok := false
		for i := 0; i < 80; i++ {
			raw, err := os.ReadFile(takeover)
			if err == nil && nonce != "" && string(raw) == nonce {
				ok = true
				break
			}
			time.Sleep(50 * time.Millisecond)
		}
		if !ok {
			log.Fatal("upgrade: timed out waiting to take entries")
		}
		s.Restore(snap)
		log.Printf("upgrade: entries taken over")
	}

	ch := make(chan os.Signal, 1)
	signal.Notify(ch, watchSignals()...)
	for sig := range ch {
		if isUpgrade(sig) {
			log.Printf("upgrade: spawning replacement")
			raw, _ := json.Marshal(s.Snapshot())
			_ = os.WriteFile(*stateFile, raw, 0o600)
			_ = os.Remove(filepath.Join(*tlsDir, "takeover"))
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
				continue
			}
			time.Sleep(300 * time.Millisecond)
			s.StopAccept()
			_ = os.WriteFile(filepath.Join(*tlsDir, "takeover"), []byte(nonce), 0o600)
			s.WaitIdle(30 * time.Second)
			log.Printf("upgrade: old process draining done, pid %d takes over", cmd.Process.Pid)
			os.Exit(0)
		}
		s.StopAccept()
		s.WaitIdle(3 * time.Second)
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

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

