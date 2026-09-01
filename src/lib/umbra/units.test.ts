import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  gateInstall,
  nodeEnrollBinCmd,
  nodeEnrollDarwinCmd,
  nodeEnrollDockerCmd,
  nodeEnrollLinuxCmd,
  nodeEnrollServiceCmd,
  nodeEnrollWindowsCmd,
  shSingleQuote,
} from "./units.ts";

const pem = `-----BEGIN CERTIFICATE-----
MIIBtest
-----END CERTIFICATE-----`;

describe("shSingleQuote", () => {
  it("wraps and escapes single quotes", () => {
    assert.equal(shSingleQuote("abc"), "'abc'");
    assert.equal(shSingleQuote("a'b"), `'a'"'"'b'`);
  });
});

describe("nodeEnrollDockerCmd", () => {
  it("embeds CA so the node host does not need a separate upload", () => {
    const cmd = nodeEnrollDockerCmd("umbra_boot_abc", "114.55.129.94:4400", pem);
    assert.match(cmd, /docker run/);
    assert.match(cmd, /chenow9\/umbra-node:latest/);
    assert.match(cmd, /--network host/);
    assert.match(cmd, /docker rm -f umbra-node/);
    assert.match(cmd, /\$HOME\/\.umbra\/ca\.crt/);
    assert.match(cmd, /BEGIN CERTIFICATE/);
    assert.match(cmd, /umbra_boot_abc/);
    assert.match(cmd, /114\.55\.129\.94:4400/);
    assert.match(cmd, /不必再下载或 scp/);
    assert.equal(cmd.includes("/Users/"), false);
  });

  it("asks for ./ca.crt when PEM is missing", () => {
    const cmd = nodeEnrollDockerCmd("umbra_boot_abc", "gate.example.com:4400");
    assert.match(cmd, /\$PWD\/ca\.crt/);
    assert.equal(cmd.includes("BEGIN CERTIFICATE"), false);
  });
});

describe("gateInstall", () => {
  it("uses the supplied address without deployment placeholders", () => {
    for (const platform of ["linux", "darwin", "windows", "docker"] as const) {
      const cmd = gateInstall(platform, "amd64", "192.0.2.10:4400");
      assert.match(cmd, /192\.0\.2\.10:4400/);
      assert.equal(/gate\.example|umbra_boot_|umbra_vis_/.test(cmd), false);
    }
  });

  it("does not create a command before the address is provided", () => {
    assert.equal(gateInstall("docker", "amd64", ""), "");
  });
});

describe("nodeEnrollBinCmd", () => {
  it("keeps legacy callers on a Linux systemd service", () => {
    const cmd = nodeEnrollBinCmd("umbra_boot_abc", "114.55.129.94:4400", pem);
    assert.match(cmd, /umbra-node_linux_amd64/);
    assert.match(cmd, /BEGIN CERTIFICATE/);
    assert.match(cmd, /systemctl enable umbra-node/);
    assert.match(cmd, /systemctl restart umbra-node/);
  });
});

describe("node enrollment system services", () => {
  it("installs Linux arm64 as a persistent systemd service", () => {
    const cmd = nodeEnrollLinuxCmd("umbra_boot_abc", "114.55.129.94:4400", "arm64", pem);
    assert.match(cmd, /umbra-node_linux_arm64/);
    assert.match(cmd, /\/etc\/systemd\/system\/umbra-node\.service/);
    assert.match(cmd, /EnvironmentFile=\/etc\/umbra\/node\.env/);
    assert.match(cmd, /ExecStart=\/usr\/local\/bin\/umbra-node/);
  });

  it("installs macOS amd64 as a persistent launchd service", () => {
    const cmd = nodeEnrollDarwinCmd("umbra_boot_abc", "114.55.129.94:4400", "amd64", pem);
    assert.match(cmd, /umbra-node_darwin_amd64/);
    assert.match(cmd, /\/Library\/LaunchDaemons\/io\.umbra\.node\.plist/);
    assert.match(cmd, /launchctl bootstrap system/);
    assert.match(cmd, /launchctl kickstart -k system\/io\.umbra\.node/);
  });

  it("dispatches every binary platform to a system service command", () => {
    const linux = nodeEnrollServiceCmd("linux", "amd64", "umbra_boot_abc", "gate:4400", pem);
    const darwin = nodeEnrollServiceCmd("darwin", "arm64", "umbra_boot_abc", "gate:4400", pem);
    const windows = nodeEnrollServiceCmd("windows", "amd64", "umbra_boot_abc", "gate:4400", pem);
    assert.match(linux, /systemctl/);
    assert.match(darwin, /launchctl/);
    assert.match(windows, /Start-Service/);
  });
});

describe("nodeEnrollWindowsCmd", () => {
  it("creates a PowerShell service command with the selected binary and embedded CA", () => {
    const cmd = nodeEnrollWindowsCmd("umbra_boot_abc", "114.55.129.94:4400", "arm64", pem);
    assert.match(cmd, /umbra-node_windows_arm64\.exe/);
    assert.match(cmd, /BEGIN CERTIFICATE/);
    assert.match(cmd, /114\.55\.129\.94:4400/);
    assert.match(cmd, /umbra_boot_abc/);
    assert.match(cmd, /WindowsBuiltInRole]::Administrator/);
    assert.match(cmd, /New-Service -Name 'UmbraNode' -BinaryPathName \$binPath/);
    assert.match(cmd, /\$LASTEXITCODE -ne 0/);
    assert.match(cmd, /Start-Service -Name 'UmbraNode'/);
    assert.doesNotMatch(cmd, /sc\.exe create UmbraNode/);
  });
});
