"use client";

import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import { useI18n } from "@/lib/i18n";
import type { Mapping } from "@/lib/umbra/types";
import { serviceState, targetAddress } from "@/lib/umbra/service";
import { cn } from "@/lib/utils";

export function ServiceList({
  mappings,
  selectedId,
  onSelect,
  renderMenu,
}: {
  mappings: Mapping[];
  selectedId?: string;
  onSelect: (id: string) => void;
  renderMenu: (mapping: Mapping) => ReactNode;
}) {
  const { t } = useI18n();
  return (
    <ul className="service-directory" aria-label={t("services.list")}>
      {mappings.map((m) => {
        const state = serviceState(m);
        const action =
          state.kind === "attention"
            ? t("services.diagnose")
            : state.kind === "pending"
              ? t("services.progress")
              : state.kind === "disabled"
                ? t("services.view")
                : t("services.connect");
        const port =
          m.mode === "visitor" ? t("services.publicClosed") : (m.entryPort ?? t("services.publicNone"));
        return (
          <li
            key={m.id}
            className={cn("service-directory-row", selectedId === m.id && "is-selected")}
          >
            <button
              className="service-directory-select"
              onClick={() => onSelect(m.id)}
              aria-pressed={selectedId === m.id}
              aria-label={`${m.name} · ${m.nodeName} · ${action}`}
            >
              <span className="service-directory-name">
                <strong>{m.name}</strong>
                <small>
                  {m.nodeName} · {m.proto.toUpperCase()}
                </small>
              </span>
              <span className="service-directory-target">
                <code>{t("services.publicPort", { port })}</code>
                <code title={targetAddress(m.localHost, m.localPort)}>
                  {t("services.target", { addr: targetAddress(m.localHost, m.localPort) })}
                </code>
              </span>
              <span className="service-directory-state" title={`${state.detail} ${state.next}`}>
                <i className={`endpoint-dot tone-${state.tone}`} />
                {state.label}
              </span>
              <span className="service-directory-action">
                {action}
                <ArrowUpRight className="size-3.5" />
              </span>
            </button>
            {renderMenu(m)}
          </li>
        );
      })}
    </ul>
  );
}
