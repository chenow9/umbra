import { serviceMatches } from "./service.ts";
import type { Mapping, Node } from "./types.ts";

export const QUICK_LAUNCH_LIMIT = 8;

export function queryWordsMatch(haystack: string, query: string) {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .every((word) => !word || haystack.toLowerCase().includes(word));
}

export function nodeMatches(node: Node, query: string) {
  return queryWordsMatch(`${node.name} ${node.addr ?? ""} ${node.comment ?? ""} ${node.id}`, query);
}

export function quickLaunchHits(query: string, mappings: Mapping[], nodes: Node[]) {
  const searching = query.trim() !== "";
  if (!searching) {
    return {
      searching: false,
      mappings: [] as Mapping[],
      mappingMore: 0,
      nodes: [] as Node[],
      nodeMore: 0,
    };
  }
  const mapped = mappings
    .filter((m) => serviceMatches(m, query))
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        a.nodeName.localeCompare(b.nodeName) ||
        a.id.localeCompare(b.id),
    );
  const noded = nodes
    .filter((n) => nodeMatches(n, query))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return {
    searching: true,
    mappings: mapped.slice(0, QUICK_LAUNCH_LIMIT),
    mappingMore: Math.max(0, mapped.length - QUICK_LAUNCH_LIMIT),
    nodes: noded.slice(0, QUICK_LAUNCH_LIMIT),
    nodeMore: Math.max(0, noded.length - QUICK_LAUNCH_LIMIT),
  };
}
