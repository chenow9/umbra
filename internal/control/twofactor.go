package control

import (
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"umbra/internal/gate"
	"umbra/internal/stealth"
)

const (
	pendingTTL     = 5 * time.Minute
	pendingMaxFail = 5
	pendingMaxN    = 64
	preAuthCookie  = "umbra_pre_auth"
	ownerCookie    = "umbra_owner"
)

var (
	errBadCreds      = errors.New("认证凭证不正确")
	errNotSetup      = errors.New("先设置口令")
	errBothFactors   = errors.New("totp 与 recoveryCode 不能同时提交")
	errForbidden2FA  = errors.New("关闭 2FA 时不能远程改绑定，请使用本机 umbrad -reset-2fa 或先开启 2FA")
	errAlreadyBound  = errors.New("已经完成绑定")
	errNeedPending   = errors.New("需要先验证口令")
	errPendingExpire = errors.New("绑定会话已过期，请重新验证口令")
)

type pendingAuth struct {
	Purpose           string
	ExpiresAt         time.Time
	Failures          int
	AuthEpoch         int64
	SourceSessionHash string
	FactorGeneration  int64
}

type loginInput struct {
	Password  string
	TOTP      string
	Recovery  string
	Migration string
	IP        string
}

type loginResult struct {
	Next      string
	SessionID string
	PreAuth   string
}

type enrollView struct {
	Issuer     string `json:"issuer"`
	Account    string `json:"account"`
	Secret     string `json:"secret"`
	OTPAuthURI string `json:"otpauthUri"`
	QRPNG      string `json:"qrPng,omitempty"`
}

type confirmResult struct {
	RecoveryCodes []string
	SessionID     string
}

type AuthView struct {
	Required               bool   `json:"required"`
	Configured             bool   `json:"configured"`
	SignedIn               bool   `json:"signedIn"`
	TwoFactorRequired      bool   `json:"twoFactorRequired"`
	TwoFactorConfigured    bool   `json:"twoFactorConfigured"`
	Next                   string `json:"next"`
	MigrationProofRequired bool   `json:"migrationProofRequired"`
	RecoveryRemaining      *int   `json:"recoveryRemaining,omitempty"`
}

func ParseTwoFactorEnv(v string) (bool, error) {
	v = strings.TrimSpace(strings.ToLower(v))
	switch v {
	case "", "on":
		return true, nil
	case "off":
		return false, nil
	default:
		return false, fmt.Errorf("UMBRA_2FA 只接受 on 或 off，当前为 %q", v)
	}
}

func AuthDisabledFromEnv() bool {
	return os.Getenv("UMBRA_LOGIN") == "off" || os.Getenv("GROK_AGENT") != "" || os.Getenv("GROK_PROJECT_ID") != ""
}

func BootstrapPath(persist string) string {
	return filepath.Join(filepath.Dir(persist), "2fa-bootstrap")
}

func controlLockPath(persist string) string {
	return filepath.Join(filepath.Dir(persist), "control.lock")
}

func tryControlLock(persist string, blocking bool) (*os.File, error) {
	path := controlLockPath(persist)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := lockFileExclusive(f, blocking); err != nil {
		_ = f.Close()
		return nil, err
	}
	return f, nil
}

func (c *Console) ReleaseLock() {
	if c.lockFile != nil {
		_ = c.lockFile.Close()
		c.lockFile = nil
	}
}

func (c *Console) SetTwoFactorRequired(req bool) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.RequireTwoFactor = req
	if c.SkipAuth || !req {
		return nil
	}
	if c.ownerHash != "" && !c.twoFactor.Confirmed && (c.migratedFromV1 || c.migrationHash != "") {
		if err := c.ensureMigrationCodeLocked(); err != nil {
			return err
		}
		return c.save()
	}
	return nil
}

func (c *Console) bootstrapPath() string {
	return BootstrapPath(c.Persist)
}

func (c *Console) ensureMigrationCodeLocked() error {
	plain, hash, err := generateMigrationCode()
	if err != nil {
		return err
	}
	body := "Umbra 控制台 2FA 迁移码\n\n" + plain + "\n\n" +
		"升级或重置后首次绑定 Authenticator 时，与管理员口令一起提交。\n" +
		"绑定成功后本文件会被删除。不要把这串码发到网上或写进仓库。\n"
	if err := writeAtomic(c.bootstrapPath(), []byte(body), 0o600); err != nil {
		return err
	}
	c.migrationHash = hash
	log.Printf("2FA 迁移码已写入 %s（不会打印明文）", c.bootstrapPath())
	return nil
}

func (c *Console) clearMigrationLocked() {
	c.migrationHash = ""
	_ = os.Remove(c.bootstrapPath())
}

func cloneTwoFactor(t persistTwoFactor) persistTwoFactor {
	t.RecoveryCodes = append([]persistRecovery(nil), t.RecoveryCodes...)
	return t
}

func (c *Console) AuthView(ownerCookie, preAuthCookie string) AuthView {
	if c.SkipAuth {
		return AuthView{
			Required:            false,
			Configured:          true,
			SignedIn:            true,
			TwoFactorRequired:   false,
			TwoFactorConfigured: true,
			Next:                "authenticated",
		}
	}
	c.mu.Lock()
	cfg := c.ownerHash != ""
	confirmed := c.twoFactor.Confirmed
	require := c.RequireTwoFactor
	mig := c.migrationHash != "" && cfg && !confirmed && require
	remain := len(c.twoFactor.RecoveryCodes)
	c.mu.Unlock()
	signed := cfg && c.validCookie(ownerCookie)
	v := AuthView{
		Required:               true,
		Configured:             cfg,
		SignedIn:               signed,
		TwoFactorRequired:      require,
		TwoFactorConfigured:    confirmed,
		MigrationProofRequired: mig,
	}
	switch {
	case !cfg:
		v.Next = "setup_password"
	case require && !confirmed:
		v.Next = "enroll_2fa"
	case signed:
		v.Next = "authenticated"
	default:
		v.Next = "login"
	}
	if signed && confirmed {
		r := remain
		v.RecoveryRemaining = &r
	}
	_ = preAuthCookie
	return v
}

type reauthInput struct {
	Password        string
	TOTP            string
	Recovery        string
	IP              string
	SessionID       string
	RequireMFA      bool
	RequireBound    bool
	ConsumeRecovery bool
}

func (c *Console) beginAuth(ip string, needHash bool) (release func(), err error) {
	if err := c.authRate.allow(ip); err != nil {
		securityEventRateLimited(ip)
		return nil, err
	}
	if !needHash {
		return func() {}, nil
	}
	rel, err := acquirePasswordHash()
	if err != nil {
		c.authRate.fail(ip)
		securityEventRateLimited(ip, "reason=hash_busy")
		return nil, err
	}
	return rel, nil
}

func (c *Console) reauthenticate(in reauthInput) error {
	if in.TOTP != "" && in.Recovery != "" {
		return errBothFactors
	}
	if err := rejectAuthSizes(in.Password, in.TOTP, in.Recovery, ""); err != nil {
		return err
	}
	release, err := c.beginAuth(in.IP, true)
	if err != nil {
		return err
	}
	c.mu.Lock()
	stored := c.ownerHash
	require := c.RequireTwoFactor
	confirmed := c.twoFactor.Confirmed
	secret := c.twoFactor.Secret
	c.mu.Unlock()
	if in.RequireBound && (!require || !confirmed) {
		release()
		c.authRate.refund(in.IP)
		return errForbidden2FA
	}
	okPW := checkPassword(in.Password, stored)
	if confirmed {
		dummyVerifyTOTP(secret, in.TOTP)
		dummyVerifyRecovery()
	}
	release()
	if stored == "" || !okPW {
		c.authRate.fail(in.IP)
		securityEvent("auth.reauth.failure", in.IP)
		return errBadCreds
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ownerHash != stored {
		c.authRate.fail(in.IP)
		return errBadCreds
	}
	if in.RequireMFA {
		if !c.sessionMFALocked(in.SessionID) {
			c.authRate.fail(in.IP)
			return errBadCreds
		}
	} else if in.SessionID != "" && !c.touchSessionLocked(in.SessionID) {
		c.authRate.fail(in.IP)
		return errBadCreds
	}
	if confirmed && !c.verifySecondLocked(in.TOTP, in.Recovery, in.ConsumeRecovery) {
		c.authRate.fail(in.IP)
		securityEvent("auth.reauth.failure", in.IP)
		return errBadCreds
	}
	c.authRate.success(in.IP)
	return nil
}

func (c *Console) loginFactors(in loginInput) (loginResult, error) {
	if in.TOTP != "" && in.Recovery != "" {
		return loginResult{}, errBothFactors
	}
	if err := rejectAuthSizes(in.Password, in.TOTP, in.Recovery, in.Migration); err != nil {
		return loginResult{}, err
	}
	release, err := c.beginAuth(in.IP, true)
	if err != nil {
		return loginResult{}, err
	}

	c.mu.Lock()
	if c.ownerHash == "" {
		c.mu.Unlock()
		release()
		c.authRate.refund(in.IP)
		return loginResult{}, errNotSetup
	}
	stored := c.ownerHash
	require := c.RequireTwoFactor
	confirmed := c.twoFactor.Confirmed
	secret := c.twoFactor.Secret
	c.mu.Unlock()

	okPW := checkPassword(in.Password, stored)
	if confirmed {
		dummyVerifyTOTP(secret, in.TOTP)
		dummyVerifyRecovery()
	}
	release()
	if !okPW {
		c.authRate.fail(in.IP)
		securityEvent("auth.login.failure", in.IP)
		return loginResult{}, errBadCreds
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ownerHash != stored {
		c.authRate.fail(in.IP)
		return loginResult{}, errBadCreds
	}

	if !require {
		sid, err := c.commitSessionLocked(false)
		if err != nil {
			return loginResult{}, err
		}
		c.authRate.success(in.IP)
		securityEvent("auth.login.success", in.IP, "mfa=false")
		return loginResult{Next: "authenticated", SessionID: sid}, nil
	}

	if !c.twoFactor.Confirmed {
		if c.migrationHash != "" && !verifyMigration(in.Migration, c.migrationHash) {
			c.authRate.fail(in.IP)
			securityEvent("auth.login.failure", in.IP)
			return loginResult{}, errBadCreds
		}
		tok, err := c.issuePendingLocked("enroll", "")
		if err != nil {
			return loginResult{}, err
		}
		c.authRate.success(in.IP)
		return loginResult{Next: "enroll_2fa", PreAuth: tok}, nil
	}

	if in.Recovery != "" {
		return c.finishRecoveryLoginLocked(in.IP, in.Recovery)
	}
	raw, err := decodeTOTPSecret(c.twoFactor.Secret)
	if err != nil || len(raw) == 0 {
		c.authRate.fail(in.IP)
		securityEvent("auth.login.failure", in.IP)
		return loginResult{}, errBadCreds
	}
	ctr, ok := verifyTOTP(raw, in.TOTP, nowFn(), c.twoFactor.LastCounter)
	if !ok {
		c.authRate.fail(in.IP)
		securityEvent("auth.login.failure", in.IP)
		return loginResult{}, errBadCreds
	}
	c.twoFactor.LastCounter = ctr
	sid, err := c.commitSessionLocked(true)
	if err != nil {
		return loginResult{}, err
	}
	c.authRate.success(in.IP)
	securityEvent("auth.login.success", in.IP, "mfa=true")
	return loginResult{Next: "authenticated", SessionID: sid}, nil
}

func (c *Console) finishRecoveryLoginLocked(ip, code string) (loginResult, error) {
	idx, ok := c.matchRecoveryLocked(code)
	if !ok {
		c.mu.Unlock()
		c.authRate.fail(ip)
		c.mu.Lock()
		return loginResult{}, errBadCreds
	}
	prevTF := cloneTwoFactor(c.twoFactor)
	prevEpoch := c.authEpoch
	prevSess := c.sessions
	prevPending := c.pending
	c.consumeRecoveryIndexLocked(idx)
	c.revokeAuthLocked()
	sid, err := c.issueSessionLocked(true)
	if err != nil {
		c.twoFactor = prevTF
		c.authEpoch = prevEpoch
		c.sessions = prevSess
		c.pending = prevPending
		return loginResult{}, err
	}
	if err := c.save(); err != nil {
		if !persistTombCommitted(err) {
			c.twoFactor = prevTF
			c.authEpoch = prevEpoch
			c.sessions = prevSess
			c.pending = prevPending
		} else {
			c.dropSessionLocked(sid)
		}
		return loginResult{}, err
	}
	c.logAudit("auth.2fa.recovery_used", "owner", fmt.Sprintf("remaining=%d", len(c.twoFactor.RecoveryCodes)))
	_ = c.saveMain()
	c.authRate.success(ip)
	securityEvent("auth.2fa.recovery_used", ip)
	return loginResult{Next: "authenticated", SessionID: sid}, nil
}

func (c *Console) revokeAuthLocked() {
	c.authEpoch++
	c.dropAllSessionsLocked()
	c.clearPendingLocked()
}

func (c *Console) clearPendingLocked() {
	c.pending = map[string]*pendingAuth{}
	c.twoFactor.PendingSecret = ""
}

func (c *Console) commitSessionLocked(mfa bool) (string, error) {
	sid, err := c.issueSessionLocked(mfa)
	if err != nil {
		return "", err
	}
	if err := c.save(); err != nil {
		c.dropSessionLocked(sid)
		return "", err
	}
	return sid, nil
}

func (c *Console) issuePendingLocked(purpose, sourceSID string) (string, error) {
	var b [32]byte
	if _, err := randRead(b[:]); err != nil {
		return "", err
	}
	plain := fmt.Sprintf("%x", b[:])
	c.prunePendingLocked()
	if len(c.pending) >= pendingMaxN {
		c.dropOldestPendingLocked()
	}
	src := ""
	if sourceSID != "" {
		src = gate.TicketHash(sourceSID)
	}
	c.pending[gate.TicketHash(plain)] = &pendingAuth{
		Purpose:           purpose,
		ExpiresAt:         nowFn().Add(pendingTTL),
		AuthEpoch:         c.authEpoch,
		SourceSessionHash: src,
		FactorGeneration:  c.twoFactor.Generation,
	}
	return plain, nil
}

func (c *Console) prunePendingLocked() {
	now := nowFn()
	for h, p := range c.pending {
		if p == nil || now.After(p.ExpiresAt) {
			delete(c.pending, h)
		}
	}
}

func (c *Console) dropOldestPendingLocked() {
	var oldest string
	var t time.Time
	for h, p := range c.pending {
		if p == nil {
			delete(c.pending, h)
			return
		}
		if oldest == "" || p.ExpiresAt.Before(t) {
			oldest, t = h, p.ExpiresAt
		}
	}
	if oldest != "" {
		delete(c.pending, oldest)
	}
}

func (c *Console) lookupPendingLocked(token string) *pendingAuth {
	if token == "" {
		return nil
	}
	c.prunePendingLocked()
	h := gate.TicketHash(token)
	p := c.pending[h]
	if p == nil || nowFn().After(p.ExpiresAt) {
		delete(c.pending, h)
		return nil
	}
	if p.AuthEpoch != c.authEpoch || p.FactorGeneration != c.twoFactor.Generation {
		delete(c.pending, h)
		return nil
	}
	if p.Purpose == "replace" {
		s := c.sessions[p.SourceSessionHash]
		if !c.sessionValidLocked(s, nowFn()) {
			delete(c.pending, h)
			return nil
		}
	}
	return p
}

func (c *Console) dropPendingLocked(token string) {
	if token == "" {
		return
	}
	delete(c.pending, gate.TicketHash(token))
}

func (c *Console) enrollmentFor(token, host string) (enrollView, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	p := c.lookupPendingLocked(token)
	if p == nil {
		return enrollView{}, errPendingExpire
	}
	var secret string
	switch p.Purpose {
	case "enroll":
		if c.twoFactor.Confirmed {
			return enrollView{}, errAlreadyBound
		}
		if c.twoFactor.Secret == "" {
			b32, err := generateTOTPSecret()
			if err != nil {
				return enrollView{}, err
			}
			c.twoFactor.Secret = b32
			if err := c.save(); err != nil {
				c.twoFactor.Secret = ""
				return enrollView{}, err
			}
		}
		secret = c.twoFactor.Secret
	case "replace":
		if !c.twoFactor.Confirmed {
			return enrollView{}, errNeedPending
		}
		if c.twoFactor.PendingSecret == "" {
			b32, err := generateTOTPSecret()
			if err != nil {
				return enrollView{}, err
			}
			c.twoFactor.PendingSecret = b32
			if err := c.save(); err != nil {
				c.twoFactor.PendingSecret = ""
				return enrollView{}, err
			}
		}
		secret = c.twoFactor.PendingSecret
	default:
		return enrollView{}, errNeedPending
	}
	return makeEnrollView(secret, host), nil
}

func (c *Console) confirmEnrollment(token, code, ip string) (confirmResult, error) {
	if err := rejectAuthSizes("", code, "", ""); err != nil {
		return confirmResult{}, err
	}
	release, err := c.beginAuth(ip, false)
	if err != nil {
		return confirmResult{}, err
	}
	release()
	c.mu.Lock()
	defer c.mu.Unlock()
	p := c.lookupPendingLocked(token)
	if p == nil {
		c.authRate.fail(ip)
		return confirmResult{}, errPendingExpire
	}
	if p.Purpose == "enroll" && c.twoFactor.Confirmed {
		c.authRate.refund(ip)
		return confirmResult{}, errAlreadyBound
	}
	if p.Purpose == "replace" && !c.twoFactor.Confirmed {
		c.authRate.fail(ip)
		return confirmResult{}, errNeedPending
	}
	secret := c.twoFactor.Secret
	if p.Purpose == "replace" {
		secret = c.twoFactor.PendingSecret
	}
	raw, err := decodeTOTPSecret(secret)
	if err != nil || len(raw) == 0 {
		c.authRate.fail(ip)
		return confirmResult{}, errBadCreds
	}
	ctr, ok := verifyTOTP(raw, code, nowFn(), 0)
	if !ok {
		p.Failures++
		if p.Failures >= pendingMaxFail {
			c.dropPendingLocked(token)
		}
		c.authRate.fail(ip)
		securityEvent("auth.2fa.confirm_failure", ip)
		return confirmResult{}, errBadCreds
	}
	codes, stored, err := generateRecoveryCodes()
	if err != nil {
		c.authRate.refund(ip)
		return confirmResult{}, err
	}
	prevTF := cloneTwoFactor(c.twoFactor)
	prevEpoch := c.authEpoch
	prevSess := c.sessions
	prevPending := c.pending
	prevMig := c.migrationHash
	purpose := p.Purpose
	if purpose == "replace" {
		c.twoFactor.Secret = c.twoFactor.PendingSecret
	}
	c.twoFactor.Confirmed = true
	c.twoFactor.LastCounter = ctr
	c.twoFactor.RecoveryCodes = stored
	c.twoFactor.Generation++
	c.revokeAuthLocked()
	c.clearMigrationLocked()
	sid, err := c.issueSessionLocked(true)
	if err != nil {
		c.twoFactor = prevTF
		c.authEpoch = prevEpoch
		c.sessions = prevSess
		c.pending = prevPending
		c.migrationHash = prevMig
		c.authRate.refund(ip)
		return confirmResult{}, err
	}
	if err := c.save(); err != nil {
		if !persistTombCommitted(err) {
			c.twoFactor = prevTF
			c.authEpoch = prevEpoch
			c.sessions = prevSess
			c.pending = prevPending
			c.migrationHash = prevMig
		} else {
			c.dropSessionLocked(sid)
		}
		c.authRate.refund(ip)
		return confirmResult{}, err
	}
	action := "auth.2fa.enrolled"
	if purpose == "replace" {
		action = "auth.2fa.replaced"
	}
	c.logAudit(action, "owner", "")
	_ = c.saveMain()
	c.authRate.success(ip)
	securityEvent(action, ip)
	return confirmResult{RecoveryCodes: codes, SessionID: sid}, nil
}

func (c *Console) startReplace(sid, password, totp, recovery, ip string) (string, error) {
	if err := c.reauthenticate(reauthInput{
		Password: password, TOTP: totp, Recovery: recovery, IP: ip,
		SessionID: sid, RequireMFA: true, RequireBound: true, ConsumeRecovery: true,
	}); err != nil {
		return "", err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.RequireTwoFactor {
		return "", errForbidden2FA
	}
	if !c.sessionMFALocked(sid) {
		return "", errBadCreds
	}
	c.clearPendingLocked()
	tok, err := c.issuePendingLocked("replace", sid)
	if err != nil {
		return "", err
	}
	if err := c.save(); err != nil {
		c.dropPendingLocked(tok)
		return "", err
	}
	securityEvent("auth.2fa.replace_started", ip)
	return tok, nil
}

func (c *Console) regenerateRecovery(sid, password, totp, recovery, ip string) ([]string, string, error) {
	if err := c.reauthenticate(reauthInput{
		Password: password, TOTP: totp, Recovery: recovery, IP: ip,
		SessionID: sid, RequireMFA: true, RequireBound: true, ConsumeRecovery: false,
	}); err != nil {
		return nil, "", err
	}
	codes, storedCodes, err := generateRecoveryCodes()
	if err != nil {
		return nil, "", err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.RequireTwoFactor || !c.sessionMFALocked(sid) {
		return nil, "", errBadCreds
	}
	prevTF := cloneTwoFactor(c.twoFactor)
	prevEpoch := c.authEpoch
	prevSess := c.sessions
	prevPending := c.pending
	c.twoFactor.RecoveryCodes = storedCodes
	c.revokeAuthLocked()
	newSID, err := c.issueSessionLocked(true)
	if err != nil {
		c.twoFactor = prevTF
		c.authEpoch = prevEpoch
		c.sessions = prevSess
		c.pending = prevPending
		return nil, "", err
	}
	if err := c.save(); err != nil {
		if !persistTombCommitted(err) {
			c.twoFactor = prevTF
			c.authEpoch = prevEpoch
			c.sessions = prevSess
			c.pending = prevPending
		} else {
			c.dropSessionLocked(newSID)
		}
		return nil, "", err
	}
	c.logAudit("auth.2fa.recovery_regenerated", "owner", "")
	_ = c.saveMain()
	securityEvent("auth.2fa.recovery_regenerated", ip)
	return codes, newSID, nil
}

func (c *Console) changePassword(sid, current, next, totp, recovery, ip string) (string, error) {
	if len(next) < 8 || len(next) > maxAuthPassword {
		return "", fmt.Errorf("口令至少 8 位")
	}
	if err := c.reauthenticate(reauthInput{
		Password: current, TOTP: totp, Recovery: recovery, IP: ip,
		SessionID: sid, ConsumeRecovery: true,
	}); err != nil {
		return "", err
	}
	release, err := acquirePasswordHash()
	if err != nil {
		return "", err
	}
	newHash, err := hashPassword(next)
	release()
	if err != nil {
		return "", err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.touchSessionLocked(sid) {
		return "", errBadCreds
	}
	prevHash, prevOwner, prevAuth := c.ownerHash, c.ownerEpoch, c.authEpoch
	prevSess := c.sessions
	prevTF := cloneTwoFactor(c.twoFactor)
	prevPending := c.pending
	c.ownerHash = newHash
	c.ownerEpoch++
	c.revokeAuthLocked()
	mfa := c.RequireTwoFactor && c.twoFactor.Confirmed
	newSID, err := c.issueSessionLocked(mfa)
	if err != nil {
		c.ownerHash, c.ownerEpoch, c.authEpoch = prevHash, prevOwner, prevAuth
		c.sessions = prevSess
		c.twoFactor = prevTF
		c.pending = prevPending
		return "", err
	}
	if err := c.save(); err != nil {
		if !persistTombCommitted(err) {
			c.ownerHash, c.ownerEpoch, c.authEpoch = prevHash, prevOwner, prevAuth
			c.sessions = prevSess
			c.twoFactor = prevTF
			c.pending = prevPending
		} else {
			c.dropSessionLocked(newSID)
		}
		return "", err
	}
	c.logAudit("auth.password.changed", "owner", "")
	_ = c.saveMain()
	securityEvent("auth.password.changed", ip)
	return newSID, nil
}

func (c *Console) verifySecondLocked(totp, recovery string, consumeRecovery bool) bool {
	if !c.twoFactor.Confirmed {
		return true
	}
	if recovery != "" {
		idx, ok := c.matchRecoveryLocked(recovery)
		if !ok {
			return false
		}
		if consumeRecovery {
			c.consumeRecoveryIndexLocked(idx)
		}
		return true
	}
	raw, err := decodeTOTPSecret(c.twoFactor.Secret)
	if err != nil {
		return false
	}
	ctr, ok := verifyTOTP(raw, totp, nowFn(), c.twoFactor.LastCounter)
	if !ok {
		return false
	}
	c.twoFactor.LastCounter = ctr
	return true
}

func (c *Console) sessionMFALocked(sid string) bool {
	if !c.touchSessionLocked(sid) {
		return false
	}
	s := c.sessions[gate.TicketHash(sid)]
	return s != nil && s.MFA
}

func ResetTwoFactor(persist string) error {
	f, err := tryControlLock(persist, false)
	if err != nil {
		return fmt.Errorf("无法锁定 tls-dir，请先停止 umbrad: %w", err)
	}
	defer f.Close()
	g := gate.New("127.0.0.1", stealth.New(false))
	c, err := New(g, persist)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ownerHash == "" {
		return fmt.Errorf("尚未设置管理员口令")
	}
	gen := c.twoFactor.Generation + 1
	c.twoFactor = persistTwoFactor{Generation: gen}
	c.revokeAuthLocked()
	if err := c.ensureMigrationCodeLocked(); err != nil {
		return err
	}
	c.logAudit("auth.2fa.local_reset", "owner", "")
	return c.save()
}
