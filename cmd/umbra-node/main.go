package main

import (
	"crypto/tls"
	"flag"
	"log"
	"os"
	"time"

	"umbra/internal/node"
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
	backoff := time.Second
	for {
		if err := node.Run(*server, *token, tlsConf); err != nil {
			log.Printf("node: %v — retry in %s", err, backoff)
			time.Sleep(backoff)
			backoff *= 2
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
			continue
		}
		backoff = time.Second
	}
}

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
