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
import { useI18n } from "@/lib/i18n";

const nav = [
  { to: "/nodes", labelKey: "nav.nodes", icon: Radio, paths: ["/", "/nodes"] },
  { to: "/mappings", labelKey: "nav.services", icon: Layers, paths: ["/mappings"] },
  { to: "/traffic", labelKey: "nav.observe", icon: Activity, paths: ["/traffic", "/audit"] },
  { to: "/deploy", labelKey: "nav.system", icon: Settings2, paths: ["/deploy"] },
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
  const { t } = useI18n();
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
        {t("nav.skip")}
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
  const { t } = useI18n();
  const overview = useQuery({ queryKey: ["umbra", "overview"], queryFn: () => getOverview() });
  const o = overview.data;
  return (
    <div className="network-telemetry" aria-label={t("shell.liveRegion")}>
      {o ? (
        <>
          <span>
            <i className="telemetry-dot" />
            {t("shell.nodesOnline", { online: o.nodesOnline, total: o.nodesTotal })}
          </span>
          <span className="font-mono">
            ↓ {formatBps(o.bpsIn)} <span className="sr-only">{t("shell.inbound")}</span>
          </span>
          <span className="font-mono">
            ↑ {formatBps(o.bpsOut)} <span className="sr-only">{t("shell.outbound")}</span>
          </span>
        </>
      ) : (
        <span>{t("shell.readingNetwork")}</span>
      )}
    </div>
  );
}

function LiveBadge() {
  const { connected } = useLiveStatus();
  const { t } = useI18n();
  return (
    <span
      className={cn(
        "hidden items-center gap-1.5 rounded-full px-2 py-1 text-xs tracking-wide uppercase sm:inline-flex",
        connected ? "text-ink-soft" : "text-stone",
      )}
      title={connected ? t("shell.liveOnTitle") : t("shell.liveOffTitle")}
    >
      <span className={cn("size-1.5 rounded-full", connected ? "bg-pine live-dot" : "bg-stone")} />
      {connected ? t("shell.liveOn") : t("shell.liveOff")}
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
  const { t } = useI18n();
  return (
    <nav aria-label={t("nav.main")} className={cn("network-nav", className)}>
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
            <span>{t(item.labelKey)}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function SignOut() {
  const { t } = useI18n();
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
      {t("shell.signOut")}
    </Button>
  );
}

function SnapshotNotice() {
  const { connected } = useLiveStatus();
  const { t } = useI18n();
  if (connected) return null;
  return (
    <p
      role="status"
      className="border-b border-line bg-paper-2 px-4 py-2 text-xs text-ink-soft md:px-8"
    >
      {t("shell.snapshotNotice")}
    </p>
  );
}
