"use client";

import { useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { caDownloadURL } from "@/lib/umbra/api";
import {
  nodeInstall,
  ARCHS,
  gateInstall,
  PLATFORMS,
  visitorInstall,
  type Arch,
  type Platform,
} from "@/lib/umbra/units";

const exampleToken = "umbra_boot_…";

export function DeployPage() {
  const [gateOs, setGateOs] = useState<Platform>("linux");
  const [gateArch, setGateArch] = useState<Arch>("amd64");
  const [nodeOs, setNodeOs] = useState<Platform>("linux");
  const [nodeArch, setNodeArch] = useState<Arch>("amd64");
  const [visitorOs, setVisitorOs] = useState<Platform>("linux");
  const [visitorArch, setVisitorArch] = useState<Arch>("amd64");
  const gate = gateInstall(gateOs, gateArch);
  const node = nodeInstall(nodeOs, nodeArch, exampleToken);
  const visitor = visitorInstall(visitorOs, visitorArch);

  return (
    <AppShell title="部署">
      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        <p className="text-sm leading-relaxed text-ink-soft">
          入口、节点与访问端支持 Linux、macOS、Windows 与 Docker，架构 amd64 / arm64。 控制台和
          API 共用一个 HTTP 口；节点和访问端走 TLS 控制通道。第一次打开网页时设定口令。
        </p>

        <aside
          className="rounded-xl bg-paper-2 px-4 py-3 shadow-border"
          aria-labelledby="deploy-check-title"
        >
          <h2 id="deploy-check-title" className="text-sm font-medium text-ink">
            部署前检查
          </h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed text-ink-soft">
            <li>管理口默认只绑定本机；跨主机访问时请放在可信 HTTPS 反向代理之后。</li>
            <li>节点控制通道使用 TLS 1.3，并需要入口签发的 ca.crt。</li>
            <li>
              口令、登录会话、节点凭证和映射都写在 <span className="font-mono">-tls-dir</span> 的
              control.json。Docker 要挂整个目录（默认 /var/lib/umbra），不要只挂证书文件。
            </li>
            <li>节点凭证只显示一次，不要写进镜像、仓库或共享脚本。</li>
          </ul>
        </aside>

        <section>
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-medium text-ink">入口 umbrad</h2>
            <Copy text={gate} label="复制入口部署命令" />
          </div>
          <Pickers scope="入口" os={gateOs} arch={gateArch} onOs={setGateOs} onArch={setGateArch} />
          {gateOs === "docker" ? (
            <p className="mb-2 text-xs text-stone">
              入口容器需要 Linux 宿主机的 host 网络。macOS / Windows 请跑本机进程。 -http 是控制台和
              API。镜像 chenow9/umbrad、chenow9/umbra-node 由 git tag（v*）构建，linux/amd64 +
              linux/arm64。预发布不打 latest。
            </p>
          ) : null}
          <pre className="overflow-x-auto rounded-xl bg-card p-4 font-mono text-xs leading-relaxed text-ink shadow-border">
            {gate.trim()}
          </pre>
        </section>

        <section>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-medium text-ink">访问端 umbra-visit</h2>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => window.open(caDownloadURL(), "_blank", "noopener")}
              >
                下载入口 CA
              </Button>
              <Copy text={visitor} label="复制访问端部署命令" />
            </div>
          </div>
          <p className="mb-2 text-xs leading-relaxed text-stone">
            装在要连内网的那台电脑上，不要装在节点上。先下载入口 CA，再到映射里签发，换掉示例里的地址和票据。
          </p>
          <Pickers
            scope="访问端"
            os={visitorOs}
            arch={visitorArch}
            onOs={setVisitorOs}
            onArch={setVisitorArch}
          />
          {visitorOs === "docker" ? (
            <p className="mb-2 text-xs text-stone">
              Docker 示例仅把本机 127.0.0.1:2222 暴露给使用者；请设置 UMBRA_TICKET，并把 ca.crt 放在
              compose 文件旁。
            </p>
          ) : null}
          <pre className="overflow-x-auto rounded-xl bg-card p-4 font-mono text-xs leading-relaxed text-ink shadow-border">
            {visitor.trim()}
          </pre>
        </section>

        <section>
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-medium text-ink">内网节点</h2>
            <Copy text={node} label="复制节点部署命令" />
          </div>
          <p className="mb-2 text-xs text-stone">
            凭证在「登记节点」时签发，只显示一次。登记弹窗里有可粘贴的 Docker 命令，入口 CA
            已写进命令，不必再单独上传。下面是不含凭证的样例。
          </p>
          <Pickers scope="节点" os={nodeOs} arch={nodeArch} onOs={setNodeOs} onArch={setNodeArch} />
          <pre className="overflow-x-auto rounded-xl bg-card p-4 font-mono text-xs leading-relaxed text-ink shadow-border">
            {node.trim()}
          </pre>
        </section>

        <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-stone">
          <li>人只用 umbrad 的 HTTP 口（页面和 API）。节点走 4400 的 TLS 控制通道。</li>
          <li>访问端按需运行，停掉进程即关闭本机端口。</li>
          <li>映射模式是 public / spa / visitor。spa 默认丢掉未敲门的包；public 是显式打开的业务口；visitor 入口不监听业务口。</li>
          <li>入口热替换时已有连接不中断；增删映射本来就不会重启入口。</li>
          <li>Docker 镜像是 linux/amd64 与 linux/arm64。Windows 容器不支持。</li>
          <li>控制通道默认 TLS 1.3。登记弹窗里的命令已包含入口 CA；compose 部署仍可单独挂 ca.crt。</li>
          <li>spa 在 Linux 入口走内核丢弃（需 CAP_NET_ADMIN）；macOS / Windows 入口是用户态断开。换入口程序发 USR2。</li>
          <li>预览里点「完成并上线」会拉起本机节点连入口。</li>
        </ul>
      </div>
    </AppShell>
  );
}

function Pickers({
  scope,
  os,
  arch,
  onOs,
  onArch,
}: {
  scope: string;
  os: Platform;
  arch: Arch;
  onOs: (v: Platform) => void;
  onArch: (v: Arch) => void;
}) {
  return (
    <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
      <ChipGroup label={`${scope}运行平台`} value={os} onChange={onOs} options={PLATFORMS} />
      <ChipGroup label={`${scope}处理器架构`} value={arch} onChange={onArch} options={ARCHS} />
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
  onChange: (v: T) => void;
  options: { id: T; label: string }[];
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1">
      {options.map((o) => (
        <Button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          size="sm"
          variant={value === o.id ? "default" : "outline"}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}

function Copy({ text, label }: { text: string; label: string }) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(text).catch(() => undefined);
        toast.success("已复制");
      }}
    >
      复制
    </Button>
  );
}
