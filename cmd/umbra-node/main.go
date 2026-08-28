package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"log"
	"os"

	"umbra/internal/node"
	"umbra/internal/retry"
	"umbra/internal/tlscfg"
)

func main() {
	server := flag.String("server", env("UMBRA_SERVER", "127.0.0.1:4400"), "入口控制通道")
	token := flag.String("token", os.Getenv("UMBRA_TOKEN"), "登记时签发的凭证")
	caFile := flag.String("tls-ca", env("UMBRA_TLS_CA", ""), "入口 CA 证书")
	plain := flag.Bool("plain", false, "不加密（仅调试）")
	flag.Parse()
	if *token == "" {
		log.Fatal("missing --token / UMBRA_TOKEN")
	}
	var tlsConf *tls.Config
	if !*plain {
		if *caFile == "" {
			log.Fatal("控制通道需要 --tls-ca / UMBRA_TLS_CA")
		}
		c, err := tlscfg.Client(*caFile)
		if err != nil {
			log.Fatal(err)
		}
		tlsConf = c
	}
	backoff := retry.Initial
	ctx := context.Background()
	for {
		if err := node.Run(*server, *token, tlsConf); err != nil {
			if errors.Is(err, node.ErrRevoked) {
				log.Fatal(err)
			}
			log.Printf("node: %v — retry in ~%s", err, backoff)
			if !retry.Sleep(ctx, backoff) {
				return
			}
			backoff = retry.Next(backoff)
			continue
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
