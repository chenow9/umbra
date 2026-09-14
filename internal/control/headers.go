package control

import (
	"crypto/sha256"
	"encoding/base64"
	"io/fs"
	"net/http"
	"regexp"
	"strings"
	"sync"
)

// Security headers for the console.
//
// Every response carries a policy that forbids framing and, for API
// responses, forbids loading anything at all. HTML documents get a policy
// derived from the served file: the built UI ships two inline bootstrap
// scripts (locale detection and the router stream barrier) whose bodies
// change per build, so their SHA-256 hashes are computed from the file
// being served instead of allowing 'unsafe-inline' for scripts. Styles
// keep 'unsafe-inline' because the component library injects style
// elements at runtime; that is a far smaller surface than inline script.
//
// HSTS is only emitted when the request arrived over TLS, either directly
// or via a trusted proxy that reports https, so a plain-HTTP loopback
// console never poisons the browser's HSTS cache for the host.
const (
	apiCSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

	hstsValue = "max-age=15552000"
)

// uiCSPDirectives are the UI policy with the script-src hashes spliced in.
var uiCSPDirectives = []string{
	"default-src 'self'",
	"script-src 'self'%s",
	"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
	"font-src 'self' data: https://fonts.gstatic.com",
	"img-src 'self' data: blob:",
	"connect-src 'self'",
	"manifest-src 'self'",
	"frame-ancestors 'none'",
	"base-uri 'self'",
	"form-action 'self'",
	"object-src 'none'",
}

func (c *Console) setSecurityHeaders(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Content-Security-Policy", apiCSP)
	if c.cookieSecure(r) {
		h.Set("Strict-Transport-Security", hstsValue)
	}
}

var inlineScriptRe = regexp.MustCompile(`(?is)<script\b([^>]*)>(.*?)</script>`)

// inlineScriptHashes returns CSP source expressions for every inline
// <script> body in the document. Scripts with a src attribute are
// covered by 'self' and skipped.
//
// The browser hashes the script text as it exists after HTML parsing,
// not the raw bytes on disk, so the body is passed through the same
// input-stream preprocessing the HTML tokenizer applies: CRLF and lone
// CR become LF, invalid UTF-8 is replaced with U+FFFD, and NUL in script
// data becomes U+FFFD. The router in the built UI emits a NUL inside its
// stream barrier script, so skipping this step would produce a hash the
// browser never matches.
func inlineScriptHashes(doc []byte) []string {
	var out []string
	for _, m := range inlineScriptRe.FindAllSubmatch(doc, -1) {
		attrs := strings.ToLower(string(m[1]))
		if strings.Contains(attrs, "src=") || len(m[2]) == 0 {
			continue
		}
		sum := sha256.Sum256([]byte(scriptTextAsParsed(string(m[2]))))
		out = append(out, "'sha256-"+base64.StdEncoding.EncodeToString(sum[:])+"'")
	}
	return out
}

func scriptTextAsParsed(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	s = strings.ToValidUTF8(s, "\uFFFD")
	s = strings.ReplaceAll(s, "\x00", "\uFFFD")
	return s
}

func buildUICSP(hashes []string) string {
	var scripts strings.Builder
	for _, h := range hashes {
		scripts.WriteByte(' ')
		scripts.WriteString(h)
	}
	parts := make([]string, len(uiCSPDirectives))
	for i, d := range uiCSPDirectives {
		if strings.Contains(d, "%s") {
			d = strings.Replace(d, "%s", scripts.String(), 1)
		}
		parts[i] = d
	}
	return strings.Join(parts, "; ")
}

type cspCacheVal struct {
	size    int64
	modTime int64
	csp     string
}

// cspCache remembers the policy per HTML document name. A Console serves
// from exactly one UI source, so the name is a sufficient key; entries
// are invalidated when the file's size or modification time changes so a
// UI directory edited during development picks up new inline scripts
// without a restart.
type cspCache struct {
	mu sync.Mutex
	m  map[string]cspCacheVal
}

func (cc *cspCache) get(fsys fs.FS, name string) string {
	st, err := fs.Stat(fsys, name)
	if err != nil {
		return buildUICSP(nil)
	}
	size, mod := st.Size(), st.ModTime().UnixNano()
	cc.mu.Lock()
	v, ok := cc.m[name]
	cc.mu.Unlock()
	if ok && v.size == size && v.modTime == mod {
		return v.csp
	}
	doc, err := fs.ReadFile(fsys, name)
	if err != nil {
		return buildUICSP(nil)
	}
	csp := buildUICSP(inlineScriptHashes(doc))
	cc.mu.Lock()
	if cc.m == nil {
		cc.m = map[string]cspCacheVal{}
	}
	cc.m[name] = cspCacheVal{size: size, modTime: mod, csp: csp}
	cc.mu.Unlock()
	return csp
}
