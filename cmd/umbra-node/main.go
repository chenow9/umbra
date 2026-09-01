package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"

	"umbra/internal/node"
	"umbra/internal/retry"
	"umbra/internal/tlscfg"
)

type config struct {
	server  string
	token   string
	tlsConf *tls.Config
}

func main() {
	cfg, err := loadConfig()
	if err != nil {
		log.Fatal(err)
	}
	handled, err := runPlatformService(func(ctx context.Context) error { return run(ctx, cfg) })
	if err != nil {
		log.Fatal(err)
	}
	if handled {
		return
	}
	if err := run(context.Background(), cfg); err != nil {
		log.Fatal(err)
	}
}

func loadConfig() (config, error) {
	server := flag.String("server", env("UMBRA_SERVER", "127.0.0.1:4400"), "入口控制通道")
	token := flag.String("token", os.Getenv("UMBRA_TOKEN"), "登记时签发的凭证")
	caFile := flag.String("tls-ca", env("UMBRA_TLS_CA", ""), "入口 CA 证书")
	plain := flag.Bool("plain", false, "不加密（仅调试）")
	flag.Parse()
	if *token == "" {
		return config{}, fmt.Errorf("missing --token / UMBRA_TOKEN")
	}
	var tlsConf *tls.Config
	if !*plain {
		if *caFile == "" {
			return config{}, fmt.Errorf("控制通道需要 --tls-ca / UMBRA_TLS_CA")
		}
		c, err := tlscfg.Client(*caFile)
		if err != nil {
			return config{}, err
		}
		tlsConf = c
	}
	return config{server: *server, token: *token, tlsConf: tlsConf}, nil
}

func run(ctx context.Context, cfg config) error {
	backoff := retry.Initial
	for {
		if err := node.RunContext(ctx, cfg.server, cfg.token, cfg.tlsConf); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			if errors.Is(err, node.ErrRevoked) {
				return err
			}
			log.Printf("node: %v — retry in ~%s", err, backoff)
			if !retry.Sleep(ctx, backoff) {
				return nil
			}
			backoff = retry.Next(backoff)
			continue
		}
		if ctx.Err() != nil {
			return nil
		}
		backoff = retry.Initial
	}
}

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
