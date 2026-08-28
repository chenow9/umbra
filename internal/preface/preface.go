package preface

import (
	"encoding/binary"
	"fmt"
	"io"
)

const (
	Magic          = "UMB1"
	KindNode  byte = 1
	KindVisit byte = 2
	maxCred        = 256
)

func Write(w io.Writer, kind byte, cred string) error {
	if kind != KindNode && kind != KindVisit {
		return fmt.Errorf("bad preface kind")
	}
	if len(cred) == 0 || len(cred) > maxCred {
		return fmt.Errorf("bad credential length")
	}
	var hdr [7]byte
	copy(hdr[:4], Magic)
	hdr[4] = kind
	binary.BigEndian.PutUint16(hdr[5:], uint16(len(cred)))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	_, err := io.WriteString(w, cred)
	return err
}

func Read(r io.Reader) (byte, string, error) {
	var hdr [7]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return 0, "", err
	}
	if string(hdr[:4]) != Magic {
		return 0, "", fmt.Errorf("bad preface magic")
	}
	kind := hdr[4]
	if kind != KindNode && kind != KindVisit {
		return 0, "", fmt.Errorf("bad preface kind")
	}
	n := int(binary.BigEndian.Uint16(hdr[5:]))
	if n == 0 || n > maxCred {
		return 0, "", fmt.Errorf("bad credential length %d", n)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return 0, "", err
	}
	return kind, string(buf), nil
}
