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
  nodeInstanceKey,
  portableVisitorCommand,
  shSingleQuote,
} from "./units.ts";

const pem = `-----BEGIN CERTIFICATE-----
MIIBtest
-----END CERTIFICATE-----`;

const nodeID = "nde_abc";
const otherID = "nde_def";

function assertLeavesLegacyInstall(cmd: string) {
  assert.doesNotMatch(cmd, /\/etc\/systemd\/system\/umbra-node\.service/);
  assert.doesNotMatch(cmd, /systemctl (?:enable|restart) umbra-node(?:\s|$)/);
  assert.doesNotMatch(cmd, /\/etc\/umbra\/node\.env/);
  assert.doesNotMatch(cmd, /tee \/etc\/umbra\/ca\.crt/);
  assert.doesNotMatch(cmd, /\.\/ca\.crt \/etc\/umbra\/ca\.crt/);
  assert.doesNotMatch(cmd, /\/Library\/LaunchDaemons\/io\.umbra\.node\.plist/);
  assert.doesNotMatch(cmd, /system\/io\.umbra\.node(?:\s|$)/);
  assert.doesNotMatch(cmd, /\/usr\/local\/libexec\/umbra-node-run(?:\s|$)/);
  assert.doesNotMatch(cmd, /\/usr\/local\/etc\/umbra\/ca\.crt/);
  assert.doesNotMatch(cmd, /\/usr\/local\/etc\/umbra\/node\.token/);
  assert.doesNotMatch(cmd, /\/usr\/local\/etc\/umbra\/server/);
  assert.doesNotMatch(cmd, /Name 'UmbraNode'/);
  assert.doesNotMatch(cmd, /sc\.exe delete UmbraNode(?:\s|$)/);
  assert.doesNotMatch(cmd, /docker rm -f umbra-node(?:\s|$)/);
  assert.doesNotMatch(cmd, /--name umbra-node(?:\s|\\)/);
  assert.doesNotMatch(cmd, /\$HOME\/\.umbra\/ca\.crt/);
  assert.doesNotMatch(cmd, /\$HOME\/\.umbra\/node\.token/);
}

describe("shSingleQuote", () => {
  it("wraps and escapes single quotes", () => {
    assert.equal(shSingleQuote("abc"), "'abc'");
    assert.equal(shSingleQuote("a'b"), `'a'"'"'b'`);
  });
});

describe("nodeInstanceKey", () => {
  it("lowercases and turns underscores into hyphens", () => {
    assert.equal(nodeInstanceKey("NDE_AbC"), "nde-abc");
    assert.equal(nodeInstanceKey("nde_0123456789abcdef0123456789abcdef"), "nde-0123456789abcdef0123456789abcdef");
  });

  it("rejects ids that are not safe in a service name or path", () => {
    for (const id of ["", "../etc", "nde abc", "nde/abc", "-nde", "nde-"]) {
      assert.throws(() => nodeInstanceKey(id));
    }
  });
});

describe("nodeEnrollDockerCmd", () => {
  it("embeds CA so the node host does not need a separate upload", () => {
    const cmd = nodeEnrollDockerCmd(nodeID, "umbra_boot_abc", "114.55.129.94:4400", pem);
    assert.match(cmd, /docker run/);
    assert.match(cmd, /chenow9\/umbra-node:latest/);
    assert.match(cmd, /--network host/);
    assert.match(cmd, /docker rm -f umbra-node-nde-abc(?:\s|$)/);
    assert.match(cmd, /--name umbra-node-nde-abc /);
    assert.match(cmd, /\$HOME\/\.umbra\/nde-abc\/ca\.crt/);
    assert.match(cmd, /BEGIN CERTIFICATE/);
    assert.match(cmd, /umbra_boot_abc/);
    assert.match(cmd, /114\.55\.129\.94:4400/);
    assert.match(cmd, /不必再下载或 scp/);
    assert.equal(cmd.includes("/Users/"), false);
    assertLeavesLegacyInstall(cmd);
  });

  it("asks for ./ca.crt when PEM is missing", () => {
    const cmd = nodeEnrollDockerCmd(nodeID, "umbra_boot_abc", "gate.example.com:4400");
    assert.match(cmd, /\$PWD\/ca\.crt/);
    assert.match(cmd, /--name umbra-node-nde-abc /);
    assert.equal(cmd.includes("BEGIN CERTIFICATE"), false);
    assertLeavesLegacyInstall(cmd);
  });

  it("mounts the credential as a file instead of passing it on the command line", () => {
    for (const cmd of [
      nodeEnrollDockerCmd(nodeID, "umbra_boot_abc", "gate.example.com:4400", pem, true),
      nodeEnrollDockerCmd(nodeID, "umbra_boot_abc", "gate.example.com:4400", undefined, true),
    ]) {
      assert.match(cmd, /umask 077/);
      assert.match(cmd, /printf '%s' 'umbra_boot_abc' >"\$HOME\/\.umbra\/nde-abc\/node\.token"/);
      assert.match(cmd, /-v "\$HOME\/\.umbra\/nde-abc\/node\.token":\/etc\/umbra\/node\.token:ro/);
      assert.match(cmd, /--token-file \/etc\/umbra\/node\.token/);
      assert.doesNotMatch(cmd, /--token ['\s]/);
      assert.doesNotMatch(cmd, /UMBRA_TOKEN/);
      assertLeavesLegacyInstall(cmd);
    }
  });

  it("replaces only this node's container when the command is run again", () => {
    const again = nodeEnrollDockerCmd(nodeID, "umbra_boot_next", "gate.example.com:4400", pem);
    const other = nodeEnrollDockerCmd(otherID, "umbra_boot_other", "gate.example.com:4400", pem);
    assert.match(again, /--name umbra-node-nde-abc /);
    assert.match(again, /umbra_boot_next/);
    assert.doesNotMatch(again, /umbra_boot_abc|nde-def/);
    assert.match(other, /--name umbra-node-nde-def /);
    assert.doesNotMatch(other, /nde-abc/);
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
  it("keeps callers without a platform on a Linux systemd service for that node", () => {
    const cmd = nodeEnrollBinCmd(nodeID, "umbra_boot_abc", "114.55.129.94:4400", pem);
    assert.match(cmd, /umbra-node_linux_amd64/);
    assert.match(cmd, /BEGIN CERTIFICATE/);
    assert.match(cmd, /systemctl enable umbra-node-nde-abc/);
    assert.match(cmd, /systemctl restart umbra-node-nde-abc/);
    assert.match(cmd, /\/usr\/local\/bin\/umbra-node/);
    assertLeavesLegacyInstall(cmd);
  });
});

describe("node enrollment system services", () => {
  it("installs Linux arm64 as a persistent systemd service", () => {
    const cmd = nodeEnrollLinuxCmd(nodeID, "umbra_boot_abc", "114.55.129.94:4400", "arm64", pem);
    assert.match(cmd, /umbra-node_linux_arm64/);
    assert.match(cmd, /\/etc\/systemd\/system\/umbra-node-nde-abc\.service/);
    assert.match(cmd, /EnvironmentFile=\/etc\/umbra\/nodes\/nde-abc\/node\.env/);
    assert.match(cmd, /ExecStart=\/usr\/local\/bin\/umbra-node/);
    assert.match(cmd, /--tls-ca \/etc\/umbra\/nodes\/nde-abc\/ca\.crt/);
    assertLeavesLegacyInstall(cmd);
    const other = nodeEnrollLinuxCmd(otherID, "umbra_boot_other", "114.55.129.94:4400", "arm64", pem);
    assert.doesNotMatch(cmd, /nde-def/);
    assert.doesNotMatch(other, /nde-abc/);
  });

  it("installs macOS amd64 as a persistent launchd service", () => {
    const cmd = nodeEnrollDarwinCmd(nodeID, "umbra_boot_abc", "114.55.129.94:4400", "amd64", pem);
    assert.match(cmd, /umbra-node_darwin_amd64/);
    assert.match(cmd, /\/usr\/local\/bin\/umbra-node/);
    assert.match(cmd, /\/Library\/LaunchDaemons\/io\.umbra\.node\.nde-abc\.plist/);
    assert.match(cmd, /launchctl bootstrap system/);
    assert.match(cmd, /launchctl kickstart -k system\/io\.umbra\.node\.nde-abc/);
    assert.match(cmd, /\/usr\/local\/libexec\/umbra-node-nde-abc/);
    assert.match(cmd, /\/usr\/local\/etc\/umbra\/nodes\/nde-abc\/ca\.crt/);
    assertLeavesLegacyInstall(cmd);
  });

  it("dispatches every binary platform to a system service command", () => {
    const linux = nodeEnrollServiceCmd("linux", "amd64", nodeID, "umbra_boot_abc", "gate:4400", pem);
    const darwin = nodeEnrollServiceCmd("darwin", "arm64", nodeID, "umbra_boot_abc", "gate:4400", pem);
    const windows = nodeEnrollServiceCmd("windows", "amd64", nodeID, "umbra_boot_abc", "gate:4400", pem);
    assert.match(linux, /systemctl enable umbra-node-nde-abc/);
    assert.match(darwin, /system\/io\.umbra\.node\.nde-abc/);
    assert.match(windows, /Start-Service -Name \$serviceName/);
    for (const cmd of [linux, darwin, windows]) assertLeavesLegacyInstall(cmd);
  });
});

describe("nodeEnrollWindowsCmd", () => {
  it("creates a PowerShell service command with the selected binary and embedded CA", () => {
    const cmd = nodeEnrollWindowsCmd(nodeID, "umbra_boot_abc", "114.55.129.94:4400", "arm64", pem);
    assert.match(cmd, /umbra-node_windows_arm64\.exe/);
    assert.match(cmd, /BEGIN CERTIFICATE/);
    assert.match(cmd, /114\.55\.129\.94:4400/);
    assert.match(cmd, /umbra_boot_abc/);
    assert.match(cmd, /WindowsBuiltInRole]::Administrator/);
    assert.match(cmd, /\$serviceName = 'UmbraNode-nde-abc'/);
    assert.match(cmd, /Join-Path \(Join-Path \$root 'nodes'\) 'nde-abc'/);
    assert.match(cmd, /New-Service -Name \$serviceName -BinaryPathName \$binPath/);
    assert.match(cmd, /--service-name ' \+ \$serviceName/);
    assert.match(cmd, /Test-Path -LiteralPath \$exe/);
    assert.match(cmd, /Write-Warning/);
    assert.match(cmd, /\$LASTEXITCODE -ne 0/);
    assert.match(cmd, /Start-Service -Name \$serviceName/);
    assert.match(cmd, /Join-Path \$app 'umbra-node\.exe'/);
    assert.doesNotMatch(cmd, /sc\.exe create UmbraNode/);
    assertLeavesLegacyInstall(cmd);
  });

  it("stores the credential in an ACL-protected file rather than the service command line", () => {
    const cmd = nodeEnrollWindowsCmd(nodeID, "umbra_boot_abc", "114.55.129.94:4400", "amd64", pem, true);
    assert.match(cmd, /\$tokenFile = Join-Path \$data 'node\.token'/);
    assert.match(cmd, /Set-Content -LiteralPath \$tokenFile -Value 'umbra_boot_abc' -NoNewline/);
    assert.match(cmd, /SetAccessRuleProtection\(\$true, \$false\)/);
    assert.match(cmd, /NT AUTHORITY\\SYSTEM/);
    assert.match(cmd, /BUILTIN\\Administrators/);
    assert.match(cmd, /--token-file "' \+ \$tokenFile \+ '"/);
    assert.match(cmd, /--service-name ' \+ \$serviceName/);
    assert.doesNotMatch(cmd, /--token ['\s]/);
    assertLeavesLegacyInstall(cmd);
  });
});

it("portable visitor commands preserve credentials and use a local CA on each OS", () => {
  const command =
    "umbra-visit --server gate.example.com:4400 --tls-ca /etc/umbra/ca.crt --ticket umbra_vis_test --local 127.0.0.1:2222";
  const windows = portableVisitorCommand(command, "windows", "arm64");
  assert.ok(windows.startsWith(".\\umbra-visit_windows_arm64.exe "));
  assert.ok(windows.includes("--tls-ca ./ca.crt"));
  assert.ok(windows.includes("--ticket umbra_vis_test"));
  const mac = portableVisitorCommand(command, "darwin", "arm64");
  assert.ok(mac.startsWith("chmod +x ./umbra-visit_darwin_arm64\n./umbra-visit_darwin_arm64 "));
  assert.ok(mac.includes("--server gate.example.com:4400"));
});

it("honors token visibility on all enrollment platforms", () => {
  for (const hide of [false, true]) {
    for (const ca of [undefined, pem]) {
      const scripts = [
        ...(["linux", "darwin", "windows"] as const).map((platform) =>
          nodeEnrollServiceCmd(platform, "amd64", nodeID, "umbra_boot_test", "gate:4400", ca, hide),
        ),
        nodeEnrollDockerCmd(nodeID, "umbra_boot_test", "gate:4400", ca, hide),
      ];
      for (const script of scripts) {
        if (hide) assert.doesNotMatch(script, /--token /);
        else assert.match(script, /--token /);
      }
      if (!hide) {
        assert.doesNotMatch(scripts[2], /tokenFile/);
        assert.doesNotMatch(scripts[3], /node\.token/);
      }
    }
  }
});
