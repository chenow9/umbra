package control

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/hex"
	"strings"
	"unicode"
)

const (
	recoveryCount  = 10
	recoveryBytes  = 10 // 80 bit → 16 Base32 chars
	recoveryChars  = 16
	recoverySaltN  = 16
	migrationBytes = 16
)

func generateRecoveryCodes() (plain []string, stored []persistRecovery, err error) {
	plain = make([]string, recoveryCount)
	stored = make([]persistRecovery, recoveryCount)
	enc := base32.StdEncoding.WithPadding(base32.NoPadding)
	for i := 0; i < recoveryCount; i++ {
		raw := make([]byte, recoveryBytes)
		if _, err = rand.Read(raw); err != nil {
			return nil, nil, err
		}
		body := enc.EncodeToString(raw)
		if len(body) < recoveryChars {
			return nil, nil, errPersist
		}
		body = body[:recoveryChars]
		plain[i] = formatGrouped(body, 4)
		salt := make([]byte, recoverySaltN)
		if _, err = rand.Read(salt); err != nil {
			return nil, nil, err
		}
		norm := normalizeRecovery(plain[i])
		stored[i] = persistRecovery{
			Salt: hex.EncodeToString(salt),
			Hash: hex.EncodeToString(recoveryHash(salt, norm)),
		}
	}
	return plain, stored, nil
}

func formatGrouped(body string, n int) string {
	if n <= 0 {
		return body
	}
	var b strings.Builder
	for i, r := range body {
		if i > 0 && i%n == 0 {
			b.WriteByte('-')
		}
		b.WriteRune(r)
	}
	return b.String()
}

func normalizeRecovery(s string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(s) {
		if r == ' ' || r == '-' {
			continue
		}
		b.WriteRune(r)
	}
	out := b.String()
	if len(out) != recoveryChars {
		return ""
	}
	for _, r := range out {
		if !isBase32Char(r) {
			return ""
		}
	}
	return out
}

func isBase32Char(r rune) bool {
	return (r >= 'A' && r <= 'Z') || (r >= '2' && r <= '7')
}

func recoveryHash(salt []byte, norm string) []byte {
	h := sha256.New()
	h.Write(salt)
	h.Write([]byte(norm))
	return h.Sum(nil)
}

func dummyVerifyRecovery() {
	_ = recoveryHash(dummyTOTPKey[:recoverySaltN], strings.Repeat("A", recoveryChars))
}

func (c *Console) matchRecoveryLocked(code string) (int, bool) {
	norm := normalizeRecovery(code)
	if norm == "" {
		dummyVerifyRecovery()
		return -1, false
	}
	found := -1
	for i, rc := range c.twoFactor.RecoveryCodes {
		salt, err := hex.DecodeString(rc.Salt)
		if err != nil {
			continue
		}
		want, err := hex.DecodeString(rc.Hash)
		if err != nil || len(want) != sha256.Size {
			continue
		}
		got := recoveryHash(salt, norm)
		if subtle.ConstantTimeCompare(got, want) == 1 {
			found = i
		}
	}
	return found, found >= 0
}

func (c *Console) consumeRecoveryIndexLocked(idx int) {
	if idx < 0 || idx >= len(c.twoFactor.RecoveryCodes) {
		return
	}
	c.twoFactor.RecoveryCodes = append(c.twoFactor.RecoveryCodes[:idx:idx], c.twoFactor.RecoveryCodes[idx+1:]...)
}

func generateMigrationCode() (plain, hash string, err error) {
	raw := make([]byte, migrationBytes)
	if _, err = rand.Read(raw); err != nil {
		return "", "", err
	}
	plain = strings.ToUpper(hex.EncodeToString(raw))
	sum := sha256.Sum256([]byte(plain))
	return formatGrouped(plain, 8), hex.EncodeToString(sum[:]), nil
}

func normalizeMigration(s string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(s) {
		if r == ' ' || r == '-' {
			continue
		}
		if !unicode.Is(unicode.ASCII_Hex_Digit, r) {
			return ""
		}
		b.WriteRune(r)
	}
	out := b.String()
	if len(out) != migrationBytes*2 {
		return ""
	}
	return out
}

func verifyMigration(plain, hash string) bool {
	norm := normalizeMigration(plain)
	if norm == "" || hash == "" {
		return false
	}
	sum := sha256.Sum256([]byte(norm))
	want, err := hex.DecodeString(hash)
	if err != nil || len(want) != sha256.Size {
		return false
	}
	return subtle.ConstantTimeCompare(sum[:], want) == 1
}
