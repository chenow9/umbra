import type { Mapping, Node } from "./types.ts";

export type TrafficSearch = {
  node?: string;
  service?: string;
  range?: "1h" | "24h" | "7d";
  chart?: "rate" | "bytes";
};

export function parseTrafficSearch(raw: Record<string, unknown>): TrafficSearch {
  const id = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  return {
    node: id(raw.node),
    service: id(raw.service),
    range: raw.range === "1h" || raw.range === "7d" ? raw.range : "24h",
    chart: raw.chart === "bytes" ? "bytes" : "rate",
  };
}

export function resolveTrafficScope(search: TrafficSearch, nodes: Node[], mappings: Mapping[]) {
  const service = search.service ? mappings.find((m) => m.id === search.service) : undefined;
  const nodeId = search.node || service?.nodeId || "";
  const node = nodeId ? nodes.find((n) => n.id === nodeId) : undefined;
  const error =
    search.service && !service
      ? "该服务已不存在。"
      : nodeId && !node
        ? "该节点已不存在。"
        : service && service.nodeId !== nodeId
          ? "该服务不属于所选节点。"
          : undefined;
  return { node, nodeId, service, error };
}
