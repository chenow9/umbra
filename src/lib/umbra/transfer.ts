import type { Mapping, Node } from "./types.ts";

export const CONFIG_BUNDLE_KIND = "umbra.config-bundle";
export const CONFIG_SCHEMA_VERSION = 1;
export const MAX_IMPORT_BYTES = 1 << 20;

export type ExportService = {
  id: string;
  nodeId: string;
  name: string;
  proto: string;
  mode: string;
  entryPort: number | null;
  localHost: string;
  localPort: number;
  enabled: boolean;
  maxConns: number;
  rateKbps: number;
  allowCidrs: string;
  idleTimeoutSec: number;
  spaTtlSec: number;
  udpIdleTimeoutSec: number;
};

export type ExportNode = {
  id: string;
  name: string;
  comment?: string;
  os?: string;
  arch?: string;
};

export type ConfigBundle = {
  schemaVersion: number;
  kind: string;
  sourceId: string;
  exportedAt: string;
  nodes: ExportNode[];
  services: ExportService[];
};

export type ImportServiceSel = { originId: string; action: "create" | "update" | "skip" };

export type ImportBinding = {
  originNodeId: string;
  action: "create" | "bind";
  localNodeId?: string;
  name?: string;
  comment?: string;
  os?: string;
  arch?: string;
  neverExpire?: boolean;
  services?: ImportServiceSel[];
};

export type PreviewDiff = { field: string; from: unknown; to: unknown };

export type PreviewService = {
  originId: string;
  name: string;
  proto: string;
  mode: string;
  entryPort: number | null;
  localHost: string;
  localPort: number;
  enabled: boolean;
  action?: string;
  matchedLocalId?: string;
  reason?: string;
  error?: boolean;
  diff?: PreviewDiff[];
};

export type PreviewNode = {
  originId: string;
  name: string;
  comment: string;
  os: string;
  arch: string;
  action?: string;
  localNodeId?: string;
  localNodeName?: string;
  previousLocalNodeIds?: string[];
  reason?: string;
  error?: boolean;
  services?: PreviewService[] | null;
};

export type PreviewLocalNode = {
  id: string;
  name: string;
  status: string;
  enabled: boolean;
  mappingCount: number;
};

export type PreviewSummary = {
  nodesCreate: number;
  nodesBind: number;
  servicesCreate: number;
  servicesUpdate: number;
  servicesSkip: number;
  conflicts: number;
};

export type ImportPreview = {
  valid: boolean;
  canApply: boolean;
  errors?: string[];
  sourceId: string;
  exportedAt: string;
  localNodes: PreviewLocalNode[];
  nodes: PreviewNode[];
  summary: PreviewSummary;
};

export type ImportNodeResult = {
  originId: string;
  localId: string;
  action: string;
  name: string;
  token?: string;
  os?: string;
  arch?: string;
  installCmd?: string;
  dockerCmd?: string;
  listen?: string;
  caPem?: string;
  expiresAt?: string;
  neverExpire?: boolean;
};

export type ImportServiceResult = {
  originId: string;
  localId?: string;
  name: string;
  action: string;
  result: string;
  pushState?: string;
  listenState?: string;
  listenError?: string;
};

export type ImportResult = {
  saved: boolean;
  nodes: ImportNodeResult[];
  services: ImportServiceResult[];
  summary: PreviewSummary;
};

export type ExportSelection = Record<string, string[] | "all">;

export function buildExportRequest(selection: ExportSelection) {
  return {
    nodes: Object.entries(selection)
      .filter(([, services]) => services === "all" || services.length > 0)
      .map(([id, services]) =>
        services === "all" ? { id } : { id, serviceIds: services },
      ),
  };
}

export function defaultSelection(nodes: Node[], preselectNodeId?: string): ExportSelection {
  const out: ExportSelection = {};
  for (const node of nodes) {
    if (node.status === "revoked") continue;
    if (preselectNodeId) {
      if (node.id === preselectNodeId) out[node.id] = "all";
      continue;
    }
    out[node.id] = "all";
  }
  return out;
}

export function servicesForNode(mappings: Mapping[], nodeId: string) {
  return mappings
    .filter((m) => m.nodeId === nodeId)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function suggestBindings(preview: ImportPreview): ImportBinding[] {
  return preview.nodes.map((node) => {
    const previous = (node.previousLocalNodeIds ?? []).find((id) =>
      preview.localNodes.some((local) => local.id === id && local.enabled && local.status !== "revoked"),
    );
    return {
      originNodeId: node.originId,
      action: previous ? "bind" : "create",
      localNodeId: previous,
      name: node.name,
      comment: node.comment,
      os: node.os || "linux",
      arch: node.arch || "amd64",
      services: [],
    };
  });
}

export function previewServices(node: { services?: PreviewService[] | null } | undefined) {
  return node?.services ?? [];
}

export function retargetBinding(
  binding: ImportBinding,
  patch: Pick<ImportBinding, "action"> & { localNodeId?: string },
): ImportBinding {
  return {
    ...binding,
    action: patch.action,
    localNodeId: patch.action === "bind" ? patch.localNodeId : undefined,
    services: [],
  };
}

export function withServiceActions(
  bindings: ImportBinding[],
  preview: ImportPreview,
): ImportBinding[] {
  return bindings.map((binding) => {
    const node = preview.nodes.find((item) => item.originId === binding.originNodeId);
    if (!node) return binding;
    return {
      ...binding,
      services: previewServices(node).map((service) => ({
        originId: service.originId,
        action: (service.action === "update" || service.action === "skip" || service.action === "create"
          ? service.action
          : service.matchedLocalId
            ? "skip"
            : "create") as ImportServiceSel["action"],
      })),
    };
  });
}

export function setServiceAction(
  bindings: ImportBinding[],
  originNodeId: string,
  originId: string,
  action: ImportServiceSel["action"],
): ImportBinding[] {
  return bindings.map((binding) => {
    if (binding.originNodeId !== originNodeId) return binding;
    const services = binding.services ?? [];
    const exists = services.some((item) => item.originId === originId);
    return {
      ...binding,
      services: exists
        ? services.map((item) => (item.originId === originId ? { ...item, action } : item))
        : [...services, { originId, action }],
    };
  });
}

export function setAllMatchedAction(
  bindings: ImportBinding[],
  preview: ImportPreview,
  action: "skip" | "update",
): ImportBinding[] {
  return bindings.map((binding) => {
    const node = preview.nodes.find((item) => item.originId === binding.originNodeId);
    if (!node) return binding;
    return {
      ...binding,
      services: previewServices(node).map((service) => ({
        originId: service.originId,
        action: service.matchedLocalId ? action : "create",
      })),
    };
  });
}

export function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportFilename(now = new Date()) {
  const stamp = now.toISOString().slice(0, 10);
  return `umbra-nodes-${stamp}.json`;
}

export function readBundleFile(file: File): Promise<ConfigBundle> {
  if (file.size > MAX_IMPORT_BYTES) {
    return Promise.reject(new Error("file too large"));
  }
  return file.text().then((text) => {
    const value = JSON.parse(text) as ConfigBundle;
    if (!value || typeof value !== "object") throw new Error("invalid json");
    return value;
  });
}

export function serviceLine(service: {
  proto: string;
  mode: string;
  entryPort: number | null;
  localHost: string;
  localPort: number;
}) {
  const dest = `${service.localHost}:${service.localPort}`;
  if (service.mode === "visitor" || service.entryPort == null) return `${service.proto} ${dest}`;
  return `${service.proto}/${service.entryPort} → ${dest}`;
}
