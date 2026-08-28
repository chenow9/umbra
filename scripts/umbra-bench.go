// Load generator for Umbra public TCP mappings.
//
//	umbra-bench -addr 127.0.0.1:18000 -n 10000 -hold 30s
package main

import (
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:18000", "public mapping address")
	n := flag.Int("n", 10000, "connections to open")
	hold := flag.Duration("hold", 15*time.Second, "how long to keep connections open")
	payload := flag.String("msg", "umbra-bench\n", "bytes to write/expect")
	timeout := flag.Duration("timeout", 8*time.Second, "per-connection dial/read timeout")
	par := flag.Int("par", 256, "dial concurrency")
	echo := flag.String("echo", "", "if set, run an echo server on this address instead")
	flag.Parse()
	if *echo != "" {
		ln, err := net.Listen("tcp", *echo)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println("echo", ln.Addr())
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
	}

	msg := []byte(*payload)
	var opened, failed, echoed atomic.Int64
	sem := make(chan struct{}, *par)
	conns := make([]net.Conn, 0, *n)
	var mu sync.Mutex
	t0 := time.Now()
	var wg sync.WaitGroup
	for i := 0; i < *n; i++ {
		sem <- struct{}{}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			d := net.Dialer{Timeout: *timeout}
			c, err := d.Dial("tcp", *addr)
			if err != nil {
				failed.Add(1)
				return
			}
			_ = c.SetDeadline(time.Now().Add(*timeout))
			if _, err := c.Write(msg); err != nil {
				failed.Add(1)
				_ = c.Close()
				return
			}
			buf := make([]byte, len(msg))
			if _, err := io.ReadFull(c, buf); err != nil {
				failed.Add(1)
				_ = c.Close()
				return
			}
			_ = c.SetDeadline(time.Time{})
			echoed.Add(1)
			opened.Add(1)
			mu.Lock()
			conns = append(conns, c)
			mu.Unlock()
		}()
	}
	wg.Wait()
	dialed := time.Since(t0)
	fmt.Printf("opened=%d echoed=%d failed=%d elapsed=%s\n", opened.Load(), echoed.Load(), failed.Load(), dialed.Round(time.Millisecond))
	if *hold > 0 {
		fmt.Fprintf(os.Stderr, "holding %d conns for %s\n", len(conns), *hold)
		time.Sleep(*hold)
	}
	for _, c := range conns {
		_ = c.Close()
	}
	fmt.Printf("closed=%d\n", len(conns))
	if opened.Load() < int64(*n) {
		os.Exit(1)
	}
}
