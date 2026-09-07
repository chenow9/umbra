"use client";

import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { Check, ChevronDown, Network, Radio, Search } from "lucide-react";
import { statusText, useI18n } from "@/lib/i18n";
import type { Node } from "@/lib/umbra/types";

export function ObservationScope({
  value,
  onChange,
  nodes,
  loading,
  error,
  onRetry,
}: {
  value: string;
  onChange: (id: string) => void;
  nodes: Node[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const current = nodes.find((node) => node.id === value);
  const currentName = value
    ? (current?.name ?? (loading ? t("observe.loading") : error ? t("observe.fail") : t("observe.unavailable")))
    : t("observe.all");
  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button className="observation-scope-trigger" aria-label={t("observe.scope", { name: currentName })}>
          <span className="observation-scope-icon">
            {value ? <Radio className="size-4" /> : <Network className="size-4" />}
          </span>
          <span className="min-w-0 flex-1 text-left">
            <strong>{currentName}</strong>
          </span>
          <ChevronDown className="size-4 shrink-0 text-stone" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="observation-scope-popover"
          aria-label={t("observe.pick")}
          align="start"
          sideOffset={8}
          collisionPadding={16}
        >
          <Command label={t("observe.pick")}>
            <div className="observation-scope-search">
              <Search className="size-4 shrink-0" />
              <Command.Input aria-label={t("observe.search")} placeholder={t("observe.searchPh")} />
            </div>
            <Command.List>
              <Command.Empty>{t("observe.empty")}</Command.Empty>
              <Command.Group>
                <Command.Item value={t("observe.allKeys")} onSelect={() => pick("")}>
                  <Network className="size-4 shrink-0" />
                  <span className="flex-1">
                    <strong>{t("observe.all")}</strong>
                    <small>{t("observe.allHint")}</small>
                  </span>
                  {!value ? <Check className="size-4" aria-label={t("observe.current")} /> : null}
                </Command.Item>
              </Command.Group>
              {loading ? (
                <p role="status" className="p-3 text-xs text-stone">
                  {t("observe.loading")}
                </p>
              ) : error ? (
                <div role="alert" className="p-3 text-xs text-rose">
                  {t("observe.fail")}
                  <button className="ml-2 underline" onClick={onRetry}>
                    {t("common.retry")}
                  </button>
                </div>
              ) : (
                <Command.Group heading={t("observe.nodeCount", { n: nodes.length })}>
                  {[...nodes]
                    .sort(
                      (a, b) =>
                        Number(b.status === "online") - Number(a.status === "online") ||
                        a.name.localeCompare(b.name),
                    )
                    .map((node) => (
                      <Command.Item
                        key={node.id}
                        value={`${node.name} ${node.addr ?? ""} ${node.id}`}
                        onSelect={() => pick(node.id)}
                      >
                        <span className={`scope-node-dot scope-${node.status}`} />
                        <span className="min-w-0 flex-1">
                          <strong>{node.name}</strong>
                          <small>
                            {t("scope.line", {
                              status: statusText(node.status),
                              count: node.mappingCount,
                            })}
                          </small>
                        </span>
                        {value === node.id ? (
                          <Check className="size-4 shrink-0" aria-label={t("observe.current")} />
                        ) : null}
                      </Command.Item>
                    ))}
                </Command.Group>
              )}
            </Command.List>
            <p className="observation-scope-footer">{t("observe.footer")}</p>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
