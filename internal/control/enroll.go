package control

import (
	"fmt"
	"os"
	"strings"
)

const nodeDockerImage = "chenow9/umbra-node:latest"

func shQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'"'"'`) + "'"
}

func (c *Console) enrollServer() string {
	if c.Listen != "" {
		return c.Listen
	}
	return "入口:4400"
}

func (c *Console) caPEM() string {
	if c.CAFile == "" {
		return ""
	}
	b, err := os.ReadFile(c.CAFile)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func writeHeredoc(b *strings.Builder, pem string) {
	b.WriteString(pem)
	if !strings.HasSuffix(pem, "\n") {
		b.WriteByte('\n')
	}
	b.WriteString("UMBRA_CA\n")
}

func (c *Console) enrollBinScript(token string) string {
	server := shQuote(c.enrollServer())
	tok := shQuote(token)
	pem := c.caPEM()
	if pem == "" {
		return "# 先把入口 ca.crt 放到 /etc/umbra/ca.crt，再执行：\n" +
			"umbra-node --server " + server + " --tls-ca /etc/umbra/ca.crt --token " + tok + "\n"
	}
	var b strings.Builder
	b.WriteString("# 入口 CA 已包含在命令中，不必再下载或 scp。\n")
	b.WriteString("mkdir -p /etc/umbra\n")
	b.WriteString("if [ -d /etc/umbra/ca.crt ]; then rm -rf /etc/umbra/ca.crt; fi\n")
	b.WriteString("cat >/etc/umbra/ca.crt <<'UMBRA_CA'\n")
	writeHeredoc(&b, pem)
	b.WriteString("umbra-node --server " + server + " --tls-ca /etc/umbra/ca.crt --token " + tok + "\n")
	return b.String()
}

func (c *Console) enrollDockerScript(token string) string {
	server := shQuote(c.enrollServer())
	tok := shQuote(token)
	pem := c.caPEM()
	var b strings.Builder
	b.WriteString("# 入口 CA 已包含在命令中，不必再下载或 scp。\n")
	b.WriteString("# --network host 让映射目标 127.0.0.1 指向这台机器。\n")
	b.WriteString("# 若提示 name already in use：docker rm -f umbra-node\n")
	if pem == "" {
		b.WriteString("# 把入口 ca.crt 放到当前目录后执行：\n")
		fmt.Fprintf(&b, "docker run -d --name umbra-node --network host --restart unless-stopped \\\n")
		fmt.Fprintf(&b, "  -v \"$PWD/ca.crt\":/etc/umbra/ca.crt:ro \\\n")
		fmt.Fprintf(&b, "  %s \\\n", nodeDockerImage)
		fmt.Fprintf(&b, "  --server %s --tls-ca /etc/umbra/ca.crt --token %s\n", server, tok)
		return b.String()
	}
	b.WriteString("umask 077\n")
	b.WriteString("mkdir -p \"$HOME/.umbra\"\n")
	b.WriteString("if [ -d \"$HOME/.umbra/ca.crt\" ]; then rm -rf \"$HOME/.umbra/ca.crt\"; fi\n")
	b.WriteString("cat >\"$HOME/.umbra/ca.crt\" <<'UMBRA_CA'\n")
	writeHeredoc(&b, pem)
	fmt.Fprintf(&b, "docker run -d --name umbra-node --network host --restart unless-stopped \\\n")
	fmt.Fprintf(&b, "  -v \"$HOME/.umbra/ca.crt\":/etc/umbra/ca.crt:ro \\\n")
	fmt.Fprintf(&b, "  %s \\\n", nodeDockerImage)
	fmt.Fprintf(&b, "  --server %s --tls-ca /etc/umbra/ca.crt --token %s\n", server, tok)
	return b.String()
}

func (c *Console) enrollFields(token string) map[string]any {
	return map[string]any{
		"installCmd": c.enrollBinScript(token),
		"dockerCmd":  c.enrollDockerScript(token),
		"listen":     c.Listen,
		"caURL":      "/v1/ca",
		"caPem":      c.caPEM(),
	}
}
