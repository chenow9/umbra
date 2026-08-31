"use client";

import { Link, Navigate, useRouterState } from "@tanstack/react-router";
import { Activity, GitBranch, LayoutGrid, Menu, Radio, ScrollText, Server } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { getOwnerStatus, getOverview, logoutOwnerSession } from "@/lib/umbra/api";
import { formatBps } from "@/lib/umbra/format";
import { useLiveStatus } from "@/lib/umbra/live";

const nav = [
  { to: "/", label: "总览", icon: LayoutGrid },
  { to: "/nodes", label: "节点", icon: Radio },
  { to: "/mappings", label: "映射", icon: GitBranch },
  { to: "/traffic", label: "流量", icon: Activity },
  { to: "/audit", label: "审计", icon: ScrollText },
  { to: "/deploy", label: "部署", icon: Server },
] as const;

export function AppShell({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [open, setOpen] = useState(false);
  const owner = useQuery({ queryKey: ["umbra", "owner"], queryFn: () => getOwnerStatus() });

  if (owner.data?.required && !owner.data.signedIn) {
    return <Navigate to="/login" />;
  }

  return (
    <div className="min-h-screen bg-paper text-ink">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-60 flex-col border-r border-line bg-paper-2/90 px-3 py-5 md:flex">
        <Brand />
        <LiveSummary />
        <Nav pathname={pathname} className="mt-5" />
      </aside>

      <div className="md:pl-60">
        <header className="sticky top-0 z-30 border-b border-line bg-paper/90 backdrop-blur-sm">
          <div className="flex flex-wrap items-center gap-2 px-4 py-3 md:gap-3 md:px-8">
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              onClick={() => setOpen(true)}
              aria-label="打开导航"
            >
              <Menu className="size-5" />
            </Button>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-lg font-medium tracking-tight text-ink">{title}</h1>
              {description ? (
                <p className="mt-0.5 hidden truncate text-xs text-stone sm:block">{description}</p>
              ) : null}
            </div>
            <LiveBadge />
            {owner.data?.required ? <SignOut /> : null}
            {action}
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl px-4 py-6 pb-24 md:px-8 md:py-8">{children}</main>
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent>
          <SheetTitle className="sr-only">主导航</SheetTitle>
          <SheetDescription className="sr-only">
            前往总览、节点、映射、流量、审计或部署页面。
          </SheetDescription>
          <Brand />
          <LiveSummary />
          <Nav pathname={pathname} className="mt-5" onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
    </div>
  );
}

function Brand() {
  return (
    <Link to="/" className="mb-4 flex items-baseline gap-2 px-2">
      <span className="font-serif text-2xl tracking-tight text-ink italic">umbra</span>
    </Link>
  );
}

function LiveSummary() {
  const overview = useQuery({ queryKey: ["umbra", "overview"], queryFn: () => getOverview() });
  const o = overview.data;
  return (
    <div className="mx-1 rounded-lg bg-paper px-3 py-2.5 shadow-border">
      <p className="text-xs tracking-wide text-stone uppercase">入口</p>
      <p className="mt-1 font-mono text-sm tabular-nums text-ink">
        {o ? `${o.nodesOnline}/${o.nodesTotal} 在线` : "—"}
      </p>
      <p className="mt-0.5 font-mono text-xs tabular-nums text-stone">
        {o ? `${formatBps(o.bpsIn)} ↓ · ${formatBps(o.bpsOut)} ↑` : "等待计数"}
      </p>
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
      {connected ? "实时" : "离线"}
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
    <nav aria-label="主导航" className={cn("flex flex-col gap-0.5", className)}>
      {nav.map((item) => {
        const active = pathname === item.to;
        const Icon = item.icon;
        return (
          <Link
            key={item.to}
            to={item.to}
            onClick={onNavigate}
            className={cn(
              "flex h-11 items-center gap-2.5 rounded-md px-2.5 text-sm transition-[background-color,color,box-shadow] duration-150 ease-out",
              active
                ? "bg-paper text-ink shadow-border"
                : "text-ink-soft hover:bg-paper/70 hover:text-ink",
            )}
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
