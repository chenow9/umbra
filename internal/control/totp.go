package control

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"net/url"
	"strings"
	"time"

	qrcode "github.com/skip2/go-qrcode"
)

const (
	totpPeriod  = 30
	totpDigits  = 6
	totpKeyLen  = 20
	totpIssuer  = "Umbra"
	totpAccount = "owner"
)

var dummyTOTPKey = bytesRepeat(0x5a, totpKeyLen)

func bytesRepeat(b byte, n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = b
	}
	return out
}

func totpEncoding() *base32.Encoding {
	return base32.StdEncoding.WithPadding(base32.NoPadding)
}

func generateTOTPSecret() (b32 string, err error) {
	raw := make([]byte, totpKeyLen)
	if _, err = rand.Read(raw); err != nil {
		return "", err
	}
	return totpEncoding().EncodeToString(raw), nil
}

func decodeTOTPSecret(b32 string) ([]byte, error) {
	s := strings.ToUpper(strings.TrimSpace(b32))
	s = strings.ReplaceAll(s, " ", "")
	s = strings.ReplaceAll(s, "-", "")
	return totpEncoding().DecodeString(s)
}

func hotp(secret []byte, counter int64, digits int) string {
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], uint64(counter))
	mac := hmac.New(sha1.New, secret)
	mac.Write(buf[:])
	sum := mac.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	bin := int64(binary.BigEndian.Uint32(sum[off:off+4]) & 0x7fffffff)
	mod := int64(1)
	for i := 0; i < digits; i++ {
		mod *= 10
	}
	return fmt.Sprintf("%0*d", digits, bin%mod)
}

func totpAt(secret []byte, now time.Time) string {
	return hotp(secret, now.Unix()/totpPeriod, totpDigits)
}

func isSixDigits(code string) bool {
	if len(code) != 6 {
		return false
	}
	for i := 0; i < 6; i++ {
		if code[i] < '0' || code[i] > '9' {
			return false
		}
	}
	return true
}

func verifyTOTP(secret []byte, code string, now time.Time, lastCounter int64) (int64, bool) {
	work := code
	validFmt := isSixDigits(code)
	if !validFmt {
		work = "000000"
	}
	want := []byte(work)
	t := now.Unix() / totpPeriod
	var match int64
	ok := 0
	for _, d := range []int64{-1, 0, 1} {
		c := t + d
		got := []byte(hotp(secret, c, totpDigits))
		eq := subtle.ConstantTimeCompare(got, want)
		usable := 0
		if c > lastCounter {
			usable = 1
		}
		take := eq & usable
		match = match*int64(1-take) + c*int64(take)
		ok |= take
	}
	if validFmt == false {
		return 0, false
	}
	return match, ok == 1
}

func dummyVerifyTOTP(secretB32, code string) {
	raw, err := decodeTOTPSecret(secretB32)
	if err != nil || len(raw) == 0 {
		raw = dummyTOTPKey
	}
	if !isSixDigits(code) {
		code = "000000"
	}
	_, _ = verifyTOTP(raw, code, nowFn(), 0)
}

func totpURI(issuer, account, secret string) string {
	label := url.QueryEscape(issuer) + ":" + url.QueryEscape(account)
	q := url.Values{}
	q.Set("secret", secret)
	q.Set("issuer", issuer)
	q.Set("algorithm", "SHA1")
	q.Set("digits", "6")
	q.Set("period", "30")
	return "otpauth://totp/" + label + "?" + q.Encode()
}

func totpAccountName(host string) string {
	host = strings.TrimSpace(host)
	if host == "" {
		host = "console"
	}
	return totpAccount + "@" + host
}

func totpQRPNG(uri string) string {
	png, err := qrcode.Encode(uri, qrcode.Medium, 256)
	if err != nil {
		return ""
	}
	return base64.StdEncoding.EncodeToString(png)
}

func makeEnrollView(b32, host string) enrollView {
	account := totpAccountName(host)
	uri := totpURI(totpIssuer, account, b32)
	return enrollView{
		Issuer:     totpIssuer,
		Account:    account,
		Secret:     b32,
		OTPAuthURI: uri,
		QRPNG:      totpQRPNG(uri),
	}
}
