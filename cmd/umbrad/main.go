package main

import (
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"time"

	"umbra/internal/gate"
	"umbra/internal/netutil"
	"umbra/internal/stealth"
	"umbra/internal/tlscfg"
)

func main() {
	listen := flag.String("listen", ":4400", "Agent 控制通道")
	api := flag.String("api", "127.0.0.1:4401", "本机管理接口，供控制台下发")
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
	aln, err := netutil.Listen("tcp", *api)
	if err != nil {
		log.Fatal(err)
	}
	s.SetListeners(cln, aln)

	mode := "tls1.3"
	if *plain {
		mode = "plain"
	}
	log.Printf("umbrad control %s (%s) api %s entry-bind %s stealth %s ca %s", *listen, mode, *api, *bind, st.Mode(), bundle.CAFile)

	go func() {
		if err := s.ServeControl(cln); err != nil {
			log.Printf("control: %v", err)
		}
	}()
	go func() {
		if err := s.ServeAPI(aln); err != nil {
			log.Printf("api: %v", err)
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
