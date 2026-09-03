package control

import (
	"strings"
	"testing"
	"time"
)

func TestHOTPRFC4226And6238(t *testing.T) {
	secret := []byte("12345678901234567890")
	if got := hotp(secret, 1, 8); got != "94287082" {
		t.Fatalf("RFC 6238 T=1 SHA1 8 digits: got %s", got)
	}
	if got := hotp(secret, 1, 6); got != "287082" {
		t.Fatalf("6-digit truncation: got %s", got)
	}
	if got := totpAt(secret, time.Unix(59, 0).UTC()); got != "287082" {
		t.Fatalf("unix 59: got %s", got)
	}
}

func TestTOTPWindowAndReplay(t *testing.T) {
	secret := []byte("12345678901234567890")
	now := time.Unix(1111111109, 0).UTC()
	code := totpAt(secret, now)
	ctr, ok := verifyTOTP(secret, code, now, 0)
	if !ok {
		t.Fatal("current window")
	}
	if _, ok := verifyTOTP(secret, code, now, ctr); ok {
		t.Fatal("replay of same counter must fail")
	}
	prev := totpAt(secret, now.Add(-30*time.Second))
	if _, ok := verifyTOTP(secret, prev, now, 0); !ok {
		t.Fatal("previous window should pass")
	}
	next := totpAt(secret, now.Add(30*time.Second))
	if _, ok := verifyTOTP(secret, next, now, 0); !ok {
		t.Fatal("next window should pass")
	}
	far := totpAt(secret, now.Add(120*time.Second))
	if _, ok := verifyTOTP(secret, far, now, 0); ok {
		t.Fatal("outside window must fail")
	}
	if _, ok := verifyTOTP(secret, "12345", now, 0); ok {
		t.Fatal("non-six digits")
	}
	if _, ok := verifyTOTP(secret, "abcdef", now, 0); ok {
		t.Fatal("non-numeric")
	}
}

func TestTOTPConcurrentSameCode(t *testing.T) {
	t.Skip("covered by TestHTTPLoginRejectsConcurrentTOTPReplay")
}

func TestTOTPSecretRoundTrip(t *testing.T) {
	b32, err := generateTOTPSecret()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(b32, "=") {
		t.Fatal("padding")
	}
	raw, err := decodeTOTPSecret(strings.ToLower(b32))
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) != totpKeyLen {
		t.Fatalf("len %d", len(raw))
	}
	uri := totpURI("Umbra", "owner@gate.example.com", b32)
	if !strings.HasPrefix(uri, "otpauth://totp/Umbra:owner%40gate.example.com?") {
		t.Fatalf("uri %s", uri)
	}
	if !strings.Contains(uri, "algorithm=SHA1") || !strings.Contains(uri, "digits=6") {
		t.Fatalf("uri params %s", uri)
	}
}
