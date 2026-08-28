package main

import (
	"context"
	"crypto/tls"
	"flag"
	"log"
	"os"
	"os/signal"

	"umbra/internal/tlscfg"
	"umbra/internal/visit"
)

func main() {
	server := flag.String("server", env("UMBRA_SERVER", "127.0.0.1:4400"), "入口控制通道")
	ticket := flag.String("ticket", os.Getenv("UMBRA_TICKET"), "访客票据")
	local := flag.String("local", env("UMBRA_LOCAL", "127.0.0.1:2222"), "本机 L4 监听 host:port")
	caFile := flag.String("tls-ca", env("UMBRA_TLS_CA", ""), "入口 CA 证书")
	plain := flag.Bool("plain", false, "不加密（仅调试）")
	flag.Parse()
	if *ticket == "" {
		log.Fatal("missing --ticket / UMBRA_TICKET")
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
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	err := visit.Run(ctx, visit.Config{
		Server: *server,
		Ticket: *ticket,
		Local:  *local,
		TLS:    tlsConf,
		OnListen: func(network, addr string) {
			log.Printf("umbra-visit %s %s → %s (ticket L4)", network, addr, *server)
		},
	})
	if err != nil && ctx.Err() == nil {
		log.Fatal(err)
	}
}

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
