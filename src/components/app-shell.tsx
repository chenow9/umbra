"use client";

import { Link, Navigate, useRouterState } from "@tanstack/react-router";
import { Activity, Layers, Radio, Settings2 } from "lucide-react";
import { type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { QuickLauncher } from "@/components/quick-launcher";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getOwnerStatus, getOverview, logoutOwnerSession } from "@/lib/umbra/api";
import { formatBps } from "@/lib/umbra/format";
import { useLiveStatus } from "@/lib/umbra/live";

const nav = [
  { to: "/nodes", label: "节点", icon: Radio, paths: ["/", "/nodes"] },
  { to: "/mappings", label: "全部服务", icon: Layers, paths: ["/mappings"] },
  { to: "/traffic", label: "观测", icon: Activity, paths: ["/traffic", "/audit"] },
  { to: "/deploy", label: "系统", icon: Settings2, paths: ["/deploy"] },
] as const;

export function AppShell({
  title,
  workspace = false,
  showTelemetry = true,
  description,
  action,
  children,
}: {
  title: string;
  workspace?: boolean;
  showTelemetry?: boolean;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const owner = useQuery({ queryKey: ["umbra", "owner"], queryFn: () => getOwnerStatus() });

  if (owner.data?.required && !owner.data.signedIn) {
    return <Navigate to="/login" />;
  }

  return (
    <div className="min-h-screen bg-paper text-ink">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-card focus:p-3"
      >
        跳到主要内容
      </a>
      <header className="network-masthead">
        <div className="network-masthead-inner">
          <Brand />
          <Nav pathname={pathname} className="desktop-navigation" />
          <div className="ml-auto flex items-center gap-3">
            <QuickLauncher />
            <LiveBadge />
            {owner.data?.required ? <SignOut /> : null}
          </div>
        </div>
      </header>
      <div className="network-context">
        <div className="network-context-inner">
          <div className="min-w-0">
            <h1 className="text-sm font-semibold">{title}</h1>
            {description ? (
              <p className="mt-1 hidden text-xs text-stone sm:block">{description}</p>
            ) : null}
          </div>
          {showTelemetry ? <LiveSummary /> : <div className="ml-auto" />}
          {action}
        </div>
      </div>
      <SnapshotNotice />
      <main id="main-content" className={cn("network-main", workspace && "network-main-workspace")}>
        {children}
      </main>
      <Nav pathname={pathname} className="mobile-navigation" />
    </div>
  );
}

function Brand() {
  return (
    <Link to="/nodes" className="network-brand" aria-label="umbra">
      <img
        src="/favicon.svg?v=umbra-eclipse-1"
        className="eclipse-mark"
        width={29}
        height={29}
        alt=""
      />
      <span>umbra</span>
    </Link>
  );
}

function LiveSummary() {
  const overview = useQuery({ queryKey: ["umbra", "overview"], queryFn: () => getOverview() });
  const o = overview.data;
  return (
    <div className="network-telemetry" aria-label="网络实时概况">
      {o ? (
        <>
          <span>
            <i className="telemetry-dot" />
            {o.nodesOnline}/{o.nodesTotal} 节点在线
          </span>
          <span className="font-mono">
            ↓ {formatBps(o.bpsIn)} <span className="sr-only">入站</span>
          </span>
          <span className="font-mono">
            ↑ {formatBps(o.bpsOut)} <span className="sr-only">出站</span>
          </span>
        </>
      ) : (
        <span>正在读取网络状态…</span>
      )}
    </div>
  );
}

function LiveBadge() {
  const { connected } = useLiveStatus();
  return (
    <span
      className={cn(
        "hidden items-center gap-1.5 rounded-full px-2 py-1 text-xs tracking-wide uppercase sm:inline-flex",
        connected ? "text-ink-soft" : "text-stone",
      )}
      title={connected ? "流量与状态正在推送" : "实时通道未连接，显示上次快照"}
    >
      <span className={cn("size-1.5 rounded-full", connected ? "bg-pine live-dot" : "bg-stone")} />
      {connected ? "实时更新" : "快照"}
    </span>
  );
}

function Nav({
  pathname,
  onNavigate,
  className,
}: {
  pathname: string;
  onNavigate?: () => void;
  className?: string;
}) {
  return (
    <nav aria-label="主导航" className={cn("network-nav", className)}>
      {nav.map((item) => {
        const active =
          (item.paths as readonly string[]).includes(pathname) ||
          (item.to === "/nodes" && pathname.startsWith("/nodes/"));
        const Icon = item.icon;
        return (
          <Link
            key={item.to}
            to={item.to}
            aria-current={active ? "page" : undefined}
            onClick={onNavigate}
            className={cn("network-nav-item", active && "is-active")}
          >
            <Icon className="size-4 opacity-70" />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function SignOut() {
  const qc = useQueryClient();
  const out = useMutation({
    mutationFn: () => logoutOwnerSession(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["umbra"] });
    },
  });
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      onClick={() => out.mutate()}
      disabled={out.isPending}
    >
      退出
    </Button>
  );
}

function SnapshotNotice() {
  const { connected } = useLiveStatus();
  if (connected) return null;
  return (
    <p
      role="status"
      className="border-b border-line bg-paper-2 px-4 py-2 text-xs text-ink-soft md:px-8"
    >
      实时状态尚未连接，当前为上次快照。通道正在自动重连；操作前请确认最新状态。
    </p>
  );
}
