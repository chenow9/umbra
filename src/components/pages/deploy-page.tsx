"use client";

import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AuthPanel } from "@/components/pages/auth-panel";
import {
  ARCHS,
  binaryName,
  gateInstall,
  PLATFORMS,
  type Arch,
  type Platform,
} from "@/lib/umbra/units";

export function DeployPage() {
  const [gateOs, setGateOs] = useState<Platform>("docker");
  const [gateArch, setGateArch] = useState<Arch>("amd64");
  const [gateAddress, setGateAddress] = useState("");

  useEffect(() => {
    const host = window.location.hostname;
    if (!host || host === "localhost" || host === "127.0.0.1" || host === "::1") return;
    setGateAddress(host.includes(":") ? `[${host}]:4400` : `${host}:4400`);
  }, []);

  const address = gateAddress.trim();
  const addressValid = validGateAddress(address);
  const gate = gateInstall(gateOs, gateArch, addressValid ? address : "");
  const gateBinary = binaryName("umbrad", gateOs, gateArch);

  return (
    <AppShell title="部署">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <div>
          <h2 className="font-serif text-2xl italic tracking-tight text-ink">按实际场景拿命令</h2>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">
            入口在这里部署；节点凭证在登记时生成；访问命令在签发票据时生成。页面不提供无法直接运行的占位命令。
          </p>
        </div>

        <section className="rounded-xl bg-card p-5 shadow-border">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-pine">01 · 入口</p>
              <h2 className="mt-1 text-base font-medium text-ink">部署 umbrad</h2>
              <p className="mt-1 text-sm text-stone">
                填写节点能够访问的入口地址，再复制完整命令。
              </p>
            </div>
            <Copy text={gate} label="复制入口部署命令" disabled={!gate} />
          </div>

          <label
            className="mt-4 block max-w-md text-sm font-medium text-ink"
            htmlFor="gate-address"
          >
            入口地址
          </label>
          <Input
            id="gate-address"
            className="mt-1 max-w-md font-mono"
            value={gateAddress}
            onChange={(event) => setGateAddress(event.target.value)}
            placeholder="公网域名或 IP:4400"
            autoComplete="off"
            spellCheck={false}
          />
          <p className="mt-1 text-xs leading-relaxed text-stone">
            {address && !addressValid
              ? "请输入带端口的域名、IPv4 或 [IPv6] 地址。"
              : "此地址会写入节点和访问端命令。使用反向代理时仍填写 4400 控制通道的直连地址。"}
          </p>

          <div className="mt-4">
            <Pickers os={gateOs} arch={gateArch} onOs={setGateOs} onArch={setGateArch} />
          </div>

          {gateOs === "docker" ? (
            <p className="mt-3 text-xs leading-relaxed text-stone">
              Docker 入口仅支持 Linux 宿主机，命令会创建持久卷并启用 host 网络。
            </p>
          ) : (
            <p className="mt-3 text-xs leading-relaxed text-stone">
              先把 <span className="font-mono text-ink">{gateBinary}</span>{" "}
              放在当前目录；命令会安装并注册系统服务。
            </p>
          )}

          {gate ? <CommandDetails command={gate} /> : null}
        </section>

        <section className="grid gap-4 sm:grid-cols-2">
          <WorkflowCard
            step="02 · 节点"
            title="登记内网节点"
            description="登记后获得包含入口 CA 和凭证的一键命令。凭证只显示一次。"
            action="去登记节点"
            to="/nodes"
          />
          <WorkflowCard
            step="03 · 访问端"
            title="签发访问命令"
            description="为 visitor 映射签发票据后，复制专属访问命令。停掉进程即关闭本机端口。"
            action="去管理映射"
            to="/mappings"
          />
        </section>

        <AuthPanel />

        <aside className="rounded-xl bg-paper-2 px-4 py-3 shadow-border">
          <h2 className="text-sm font-medium text-ink">上线前确认</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed text-ink-soft">
            <li>管理口默认只绑定本机；跨主机访问时放在可信 HTTPS 反向代理之后。</li>
            <li>控制通道使用 TLS 1.3；不要使用仅供调试的 plain 模式。</li>
            <li>Docker 必须持久化整个 /var/lib/umbra，节点凭证不要写入镜像或仓库。</li>
            <li>Linux 入口需要 NET_ADMIN 才能让 SPA 未授权端口表现为 filtered。</li>
          </ul>
        </aside>
      </div>
    </AppShell>
  );
}

function validGateAddress(value: string) {
  const match = /^(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:.%]+\]):([0-9]{1,5})$/.exec(value);
  if (!match) return false;
  const port = Number(match[1]);
  return port > 0 && port <= 65535;
}

function WorkflowCard({
  step,
  title,
  description,
  action,
  to,
}: {
  step: string;
  title: string;
  description: string;
  action: string;
  to: "/nodes" | "/mappings";
}) {
  return (
    <section className="flex min-h-44 flex-col rounded-xl bg-card p-5 shadow-border">
      <p className="text-xs font-medium text-pine">{step}</p>
      <h2 className="mt-1 text-base font-medium text-ink">{title}</h2>
      <p className="mt-2 flex-1 text-sm leading-relaxed text-stone">{description}</p>
      <Button className="mt-4 self-start" variant="outline" asChild>
        <Link to={to}>{action}</Link>
      </Button>
    </section>
  );
}

function CommandDetails({ command }: { command: string }) {
  return (
    <details className="mt-4 rounded-lg bg-paper-2 shadow-border">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-ink">
        查看完整命令
      </summary>
      <pre className="border-t border-line whitespace-pre-wrap break-all p-3 font-mono text-xs leading-relaxed text-ink">
        {command.trim()}
      </pre>
    </details>
  );
}

function Pickers({
  os,
  arch,
  onOs,
  onArch,
}: {
  os: Platform;
  arch: Arch;
  onOs: (value: Platform) => void;
  onArch: (value: Arch) => void;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
      <ChipGroup label="入口运行平台" value={os} onChange={onOs} options={PLATFORMS} />
      <ChipGroup label="入口处理器架构" value={arch} onChange={onArch} options={ARCHS} />
    </div>
  );
}

function ChipGroup<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: { id: T; label: string }[];
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1">
      {options.map((option) => (
        <Button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          size="sm"
          variant={value === option.id ? "default" : "outline"}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

function Copy({
  text,
  label,
  disabled = false,
}: {
  text: string;
  label: string;
  disabled?: boolean;
}) {
  return (
    <Button
      type="button"
      size="sm"
      aria-label={label}
      disabled={disabled}
      onClick={() => {
        void navigator.clipboard.writeText(text).catch(() => undefined);
        toast.success("部署命令已复制");
      }}
    >
      复制部署命令
    </Button>
  );
}
