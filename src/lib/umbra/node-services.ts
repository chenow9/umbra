import type { Mapping, Node } from "./types.ts";
import { serviceMatches, serviceSummary } from "./service.ts";

// Aggregate the full dataset before paginating nodes or their services.
export function nodeServiceSummaries(nodes: Node[], mappings: Mapping[], query = "") {
  const groups = new Map<string, Mapping[]>();
  for (const mapping of mappings) {
    const group = groups.get(mapping.nodeId) ?? [];
    group.push(mapping);
    groups.set(mapping.nodeId, group);
  }
  const term = query.trim().toLowerCase();
  return nodes
    .map((node) => {
      const services = groups.get(node.id) ?? [];
      return { node, services, summary: serviceSummary(services) };
    })
    .filter(
      ({ node, services }) =>
        !term ||
        `${node.name} ${node.addr ?? ""}`.toLowerCase().includes(term) ||
        services.some((service) => serviceMatches(service, term)),
    )
    .sort(
      (a, b) =>
        b.summary.attention - a.summary.attention ||
        a.node.name.localeCompare(b.node.name) ||
        a.node.id.localeCompare(b.node.id),
    );
}
