"use client";

import { Link, Navigate, useRouterState } from "@tanstack/react-router";
import { Activity, GitBranch, LayoutGrid, Menu, Radio, ScrollText, Server } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { ThemeMenu } from "@/components/theme-picker";
import { useTheme } from "@/components/app-providers";
import { cn } from "@/lib/utils";
import { getOwnerStatus, logoutOwnerSession } from "@/lib/umbra/api";

const nav = [
  { to: "/", label: "总览", icon: LayoutGrid },
  { to: "/agents", label: "节点", icon: Radio },
  { to: "/mappings", label: "映射", icon: GitBranch },
  { to: "/traffic", label: "流量", icon: Activity },
  { to: "/audit", label: "审计", icon: ScrollText },
  { to: "/deploy", label: "部署", icon: Server },
] as const;

export function AppShell({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const owner = useQuery({ queryKey: ["umbra", "owner"], queryFn: () => getOwnerStatus() });

  if (owner.data?.required && !owner.data.signedIn) {
    return <Navigate to="/login" />;
  }

  return (
    <div className="min-h-screen bg-paper text-ink">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-56 flex-col border-r border-line bg-paper-2/80 px-4 py-6 pb-24 md:flex">
        <Brand />
        <Nav pathname={pathname} />
        <p className="mt-auto px-2 text-xs leading-relaxed text-stone">
          配置只在这里改。节点不上配置文件。
        </p>
      </aside>

      <div className="md:pl-56">
        <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-line bg-paper/90 px-4 py-3 backdrop-blur-sm md:gap-3 md:px-8">
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
          </div>
          <ThemeMenu value={theme} onChange={setTheme} />
          {owner.data?.required ? <SignOut /> : null}
          {action}
        </header>

        <main className="px-4 py-6 pb-24 md:px-8 md:py-8">{children}</main>
      </div>

      <Sheet modal={false} open={open} onOpenChange={setOpen}>
        <SheetContent>
          <Brand />
          <Nav pathname={pathname} onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
    </div>
  );
}

function Brand() {
  return (
    <Link to="/" className="mb-8 flex items-baseline gap-2 px-2">
      <span className="font-serif text-2xl tracking-tight text-ink italic">幽门</span>
      <span className="text-xs tracking-[0.18em] text-stone uppercase">Umbra</span>
    </Link>
  );
}

function Nav({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-0.5">
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
              active ? "bg-paper text-ink shadow-border" : "text-ink-soft hover:bg-paper/70 hover:text-ink",
            )}
          >
            <Icon className="size-4 opacity-70" />
            {item.label}
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
    <Button type="button" size="sm" variant="ghost" onClick={() => out.mutate()} disabled={out.isPending}>
      退出
    </Button>
  );
}
