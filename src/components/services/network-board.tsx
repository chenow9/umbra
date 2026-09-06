"use client";
import {
  ArrowUpRight,
  Plus,
  Radio,
  ShieldCheck,
  Globe2,
  Timer,
  CornerDownRight,
} from "lucide-react";
import type { ReactNode } from "react";
import type { Mapping } from "@/lib/umbra/types";
import { serviceState, targetAddress, accessOptions } from "@/lib/umbra/service";
import { cn } from "@/lib/utils";

export function NetworkBoard({
  mappings,
  selectedId,
  onSelect,
  onAdd,
  renderMenu,
}: {
  mappings: Mapping[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onAdd: (nodeId: string) => void;
  renderMenu: (mapping: Mapping) => ReactNode;
}) {
  const groups = new Map<string, Mapping[]>();
  for (const m of mappings) groups.set(m.nodeId, [...(groups.get(m.nodeId) ?? []), m]);
  const attentionCount = (services: Mapping[]) =>
    services.filter((m) => serviceState(m).kind === "attention").length;
  const sortedGroups = [...groups.entries()].sort(
    ([, a], [, b]) =>
      attentionCount(b) - attentionCount(a) || a[0].nodeName.localeCompare(b[0].nodeName),
  );
  return (
    <div className="topology-board">
      <div className="topology-board-legend">
        <span>
          <span className="map-entry-mark" />
          UMBRA <span className="text-stone">/ 入口</span>
        </span>
        <span>
          <CornerDownRight className="size-3" />
          节点 → 服务目标
        </span>
      </div>
      <div className="topology-groups">
        {sortedGroups.map(([nodeId, services]) => {
          const first = services[0];
          const online = first.nodeStatus === "online";
          return (
            <section
              key={nodeId}
              className={cn("topology-cluster", !online && "cluster-offline")}
              aria-label={`${first.nodeName} 的服务`}
            >
              <div className="topology-node">
                <span className="node-junction" aria-hidden="true">
                  <Radio className="size-5" />
                </span>
                <h3>{first.nodeName}</h3>
                <p>
                  <i className={online ? "is-online" : ""} />
                  {online ? "节点在线" : first.nodeStatus === "revoked" ? "节点已吊销" : "节点离线"}
                </p>
                <p>
                  当前显示 {services.length} 项服务 · {attentionCount(services)} 项需处理
                </p>
                <button
                  type="button"
                  onClick={() => onAdd(nodeId)}
                  disabled={first.nodeStatus === "revoked"}
                  aria-label={`为 ${first.nodeName} 添加服务`}
                >
                  <Plus className="size-3" />
                  添加服务
                </button>
              </div>
              <ul className="topology-endpoints">
                {services.map((m) => {
                  const state = serviceState(m);
                  const Icon =
                    m.mode === "visitor" ? ShieldCheck : m.mode === "spa" ? Timer : Globe2;
                  return (
                    <li
                      key={m.id}
                      className={cn(
                        "topology-endpoint",
                        `endpoint-${state.kind}`,
                        selectedId === m.id && "endpoint-selected",
                      )}
                    >
                      <button
                        className="endpoint-select"
                        type="button"
                        onClick={() => onSelect(m.id)}
                        aria-pressed={selectedId === m.id}
                        aria-label={`${m.name} · ${state.kind === "attention" ? "诊断" : state.kind === "disabled" ? "查看" : state.kind === "pending" ? "查看进度" : "连接"}`}
                      >
                        <span className="endpoint-heading">
                          <Icon className="size-4" />
                          <strong>{m.name}</strong>
                          <span className="endpoint-protocol">{m.proto.toUpperCase()}</span>
                        </span>
                        <code>
                          对外端口 {m.mode === "visitor" ? "不开放" : (m.entryPort ?? "未分配")}
                        </code>
                        <code>目标 {targetAddress(m.localHost, m.localPort)}</code>
                        <span className="endpoint-policy">
                          {accessOptions.find((o) => o.mode === m.mode)?.label}
                        </span>
                        <span className="endpoint-status">
                          <i className={`endpoint-dot tone-${state.tone}`} />
                          {state.label}
                          <ArrowUpRight className="size-3.5" />
                        </span>
                      </button>
                      <div className="endpoint-menu">{renderMenu(m)}</div>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
      <p className="topology-footnote">连线表示配置中的归属关系，不代表网络已经连通。</p>
    </div>
  );
}
