"use client";

import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { Mapping, Node } from "@/lib/umbra/types";
import { nodeServiceSummaries } from "@/lib/umbra/node-services";
import { PAGE_SIZE, pageOf } from "@/lib/umbra/page";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Pager } from "@/components/ui/pager";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { statusText, useI18n } from "@/lib/i18n";

export function NodeScopePicker({
  nodes,
  mappings,
  nodeId,
  onSelect,
}: {
  nodes: Node[];
  mappings: Mapping[];
  nodeId?: string;
  onSelect: (id?: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const groups = nodeServiceSummaries(nodes, mappings, query);
  const result = pageOf(groups, page, PAGE_SIZE);
  const select = (id?: string) => {
    onSelect(id);
    setOpen(false);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="w-full justify-between" aria-label={t("scope.filter")}>
          <span className="truncate">
            {nodeId
              ? (nodes.find((node) => node.id === nodeId)?.name ?? t("services.missingNodeName"))
              : t("scope.all")}
          </span>
          <ChevronDown className="size-4 shrink-0 text-stone" />
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[85dvh] max-w-lg flex-col">
        <DialogHeader>
          <DialogTitle>{t("scope.title")}</DialogTitle>
          <DialogDescription>{t("scope.hint")}</DialogDescription>
        </DialogHeader>
        <Input
          aria-label={t("scope.search")}
          placeholder={t("scope.searchPh")}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(1);
          }}
          className="mb-3 shrink-0 bg-card"
        />
        <div className="min-h-0 overflow-y-auto">
          <Button variant="ghost" className="mb-2 w-full justify-between" onClick={() => select()}>
            {t("scope.all")} {!nodeId ? <Check className="size-4" /> : null}
          </Button>
          {groups.length ? (
            <ul className="node-scope-list" aria-label={t("scope.list")}>
              {result.items.map(({ node, summary }) => (
                <li key={node.id}>
                  <button
                    aria-label={t("scope.pick", { name: node.name })}
                    aria-pressed={nodeId === node.id}
                    onClick={() => select(node.id)}
                  >
                    <span className="min-w-0 flex-1">
                      <strong className="block break-all text-sm font-medium">{node.name}</strong>
                      <span className="mt-1 block text-xs text-stone">
                        {t("scope.line", {
                          status: statusText(node.status),
                          count: summary.total,
                        })}
                      </span>
                    </span>
                    {summary.attention > 0 ? (
                      <span className="shrink-0 text-xs text-rose">
                        {t("scope.attention", { n: summary.attention })}
                      </span>
                    ) : null}
                    {nodeId === node.id ? <Check className="size-4 shrink-0" /> : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-8 text-center text-sm text-stone">{t("scope.empty")}</p>
          )}
        </div>
        {groups.length > PAGE_SIZE ? (
          <Pager page={result.page} size={result.size} total={result.total} onPage={setPage} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
