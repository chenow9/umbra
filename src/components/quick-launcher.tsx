"use client";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Command } from "cmdk";
import { ArrowUpRight, Plus, Search, Radio, Activity, Settings2 } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useI18n } from "@/lib/i18n";
import { listMappings, listNodes } from "@/lib/umbra/api";
import { queryWordsMatch, quickLaunchHits } from "@/lib/umbra/quick-launch";
import { serviceState, targetAddress } from "@/lib/umbra/service";

export function QuickLauncher() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const mappings = useQuery({
    queryKey: ["umbra", "mappings"],
    queryFn: listMappings,
    enabled: open,
  });
  const nodes = useQuery({ queryKey: ["umbra", "nodes"], queryFn: listNodes, enabled: open });
  const close = () => {
    setOpen(false);
    setQuery("");
  };
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        if (
          !open &&
          document.querySelector('[role="dialog"]:not([data-workspace-inspector="true"])')
        )
          return;
        event.preventDefault();
        setOpen((value) => {
          const next = !value;
          if (!next) setQuery("");
          return next;
        });
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [open]);
  const go = (to: "/mappings" | "/nodes" | "/traffic" | "/deploy", search = {}) => {
    close();
    void navigate({ to, search });
  };
  const actions = [
    {
      value: t("quick.addKeys"),
      label: t("quick.add"),
      icon: Plus,
      to: "/mappings" as const,
    },
    {
      value: t("quick.nodeKeys"),
      label: t("quick.nodes"),
      icon: Radio,
      to: "/nodes" as const,
    },
    {
      value: t("quick.trafficKeys"),
      label: t("quick.traffic"),
      icon: Activity,
      to: "/traffic" as const,
    },
    {
      value: t("quick.systemKeys"),
      label: t("quick.system"),
      icon: Settings2,
      to: "/deploy" as const,
    },
  ];
  const hits = quickLaunchHits(query, mappings.data ?? [], nodes.data ?? []);
  const visibleActions = hits.searching
    ? actions.filter((action) => queryWordsMatch(action.value, query))
    : actions;
  return (
    <>
      <button
        className="quick-launch-trigger"
        aria-label={t("quick.trigger")}
        onClick={() => setOpen(true)}
      >
        <Search className="size-4" />
        <span>{t("quick.go")}</span>
        <kbd>⌘ / Ctrl K</kbd>
      </button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}
      >
        <DialogContent className="quick-launch-dialog max-w-xl p-0">
          <DialogTitle className="sr-only">{t("quick.title")}</DialogTitle>
          <DialogDescription className="sr-only">{t("quick.hint")}</DialogDescription>
          <Command shouldFilter={false} label={t("quick.label")}>
            <div className="quick-search">
              <Search className="size-5 shrink-0" />
              <Command.Input
                autoFocus
                value={query}
                onValueChange={setQuery}
                placeholder={t("quick.placeholder")}
              />
            </div>
            <Command.List>
              <Command.Empty>{t("quick.empty")}</Command.Empty>
              {visibleActions.length > 0 ? (
                <Command.Group heading={t("quick.actions")}>
                  {visibleActions.map((action) => {
                    const Icon = action.icon;
                    return (
                      <Command.Item
                        key={action.value}
                        value={action.value}
                        disabled={action.to === "/mappings" && (nodes.isPending || nodes.isError)}
                        onSelect={() => {
                          if (action.to !== "/mappings") {
                            go(action.to);
                            return;
                          }
                          if (nodes.data?.some((n) => n.status !== "revoked")) {
                            go("/mappings", { create: true });
                            return;
                          }
                          go("/nodes");
                        }}
                      >
                        <Icon />
                        {action.label}
                        <ArrowUpRight />
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              ) : null}
              {hits.searching ? (
                <>
                  {mappings.isPending ? (
                    <p className="p-4 text-xs text-stone" role="status">
                      {t("quick.readingServices")}
                    </p>
                  ) : null}
                  {mappings.isError ? (
                    <p className="p-4 text-xs text-rose" role="alert">
                      {t("quick.servicesFail")}
                    </p>
                  ) : null}
                  {hits.mappings.length > 0 || hits.mappingMore > 0 ? (
                    <Command.Group heading={t("quick.services")}>
                      {hits.mappings.map((m) => (
                        <Command.Item
                          key={m.id}
                          value={`${m.name} ${m.nodeName} ${m.localHost} ${m.localPort} ${m.proto} ${m.id}`}
                          onSelect={() => go("/mappings", { node: m.nodeId, service: m.id })}
                        >
                          <span className="quick-service-icon">{m.proto.toUpperCase()}</span>
                          <span className="min-w-0 flex-1">
                            <strong className="block truncate text-sm font-medium">{m.name}</strong>
                            <small className="block truncate text-stone">
                              {m.nodeName} · {targetAddress(m.localHost, m.localPort)}
                            </small>
                          </span>
                          <span className="text-[10px] text-stone">{serviceState(m).label}</span>
                          <ArrowUpRight />
                        </Command.Item>
                      ))}
                      {hits.mappingMore > 0 ? (
                        <Command.Item
                          value={`more-services ${query}`}
                          onSelect={() => go("/mappings")}
                        >
                          <span className="min-w-0 flex-1 text-stone">
                            {t("quick.moreServices", { n: hits.mappingMore })}
                          </span>
                          <ArrowUpRight />
                        </Command.Item>
                      ) : null}
                    </Command.Group>
                  ) : null}
                  {nodes.isPending ? (
                    <p className="p-4 text-xs text-stone" role="status">
                      {t("quick.readingNodes")}
                    </p>
                  ) : null}
                  {nodes.isError ? (
                    <p className="p-4 text-xs text-rose" role="alert">
                      {t("quick.nodesFail")}
                    </p>
                  ) : null}
                  {hits.nodes.length > 0 || hits.nodeMore > 0 ? (
                    <Command.Group heading={t("quick.nodeGroup")}>
                      {hits.nodes.map((node) => (
                        <Command.Item
                          key={node.id}
                          value={`节点 nodes ${node.name} ${node.addr ?? ""} ${node.comment ?? ""} ${node.id}`}
                          onSelect={() => go("/mappings", { node: node.id })}
                        >
                          <Radio />
                          <span className="min-w-0 flex-1 truncate">{node.name}</span>
                          <span className="text-xs text-stone">
                            {t("nodes.services", { count: node.mappingCount })}
                          </span>
                          <ArrowUpRight />
                        </Command.Item>
                      ))}
                      {hits.nodeMore > 0 ? (
                        <Command.Item value={`more-nodes ${query}`} onSelect={() => go("/nodes")}>
                          <span className="min-w-0 flex-1 text-stone">
                            {t("quick.moreNodes", { n: hits.nodeMore })}
                          </span>
                          <ArrowUpRight />
                        </Command.Item>
                      ) : null}
                    </Command.Group>
                  ) : null}
                </>
              ) : null}
            </Command.List>
            <div className="quick-launch-footer">
              <span>{t("quick.select")}</span>
              <span>{t("quick.open")}</span>
              <span>{t("quick.esc")}</span>
            </div>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}
