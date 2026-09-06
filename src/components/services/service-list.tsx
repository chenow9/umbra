"use client";

import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import type { Mapping } from "@/lib/umbra/types";
import { accessOptions, serviceState, targetAddress } from "@/lib/umbra/service";
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
  return (
    <ul className="service-directory" aria-label="服务列表">
      {mappings.map((m) => {
        const state = serviceState(m);
        const action =
          state.kind === "attention"
            ? "诊断"
            : state.kind === "pending"
              ? "查看进度"
              : state.kind === "disabled"
                ? "查看"
                : "连接";
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
                <code>对外端口 {m.mode === "visitor" ? "不开放" : (m.entryPort ?? "未分配")}</code>
                <code title={targetAddress(m.localHost, m.localPort)}>
                  目标 {targetAddress(m.localHost, m.localPort)}
                </code>
                <small>{accessOptions.find((option) => option.mode === m.mode)?.label}</small>
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
