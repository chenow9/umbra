package control

import (
	"strings"
	"testing"
)

func TestRecoveryNormalizeAndOnce(t *testing.T) {
	plain, stored, err := generateRecoveryCodes()
	if err != nil {
		t.Fatal(err)
	}
	if len(plain) != 10 || len(stored) != 10 {
		t.Fatal("count")
	}
	c := &Console{twoFactor: persistTwoFactor{RecoveryCodes: stored, Confirmed: true}}
	idx, ok := c.matchRecoveryLocked(strings.ToLower(strings.ReplaceAll(plain[0], "-", " ")))
	if !ok || idx != 0 {
		t.Fatalf("match %v %d", ok, idx)
	}
	c.consumeRecoveryIndexLocked(idx)
	if _, ok := c.matchRecoveryLocked(plain[0]); ok {
		t.Fatal("consumed code still matches")
	}
	if _, ok := c.matchRecoveryLocked("!!!!"); ok {
		t.Fatal("garbage")
	}
}

func TestMigrationNormalize(t *testing.T) {
	plain, hash, err := generateMigrationCode()
	if err != nil {
		t.Fatal(err)
	}
	if !verifyMigration(plain, hash) {
		t.Fatal("plain")
	}
	if !verifyMigration(strings.ToLower(strings.ReplaceAll(plain, "-", "")), hash) {
		t.Fatal("normalized")
	}
	if verifyMigration("00", hash) {
		t.Fatal("short")
	}
}
