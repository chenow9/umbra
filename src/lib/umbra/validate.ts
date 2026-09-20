const NODE_NAME_MAX = 200;
const HOST_MAX = 253;
const LABEL_MAX = 63;

export function validNodeName(raw: string): boolean {
  const name = raw.trim();
  if (!name || [...name].length > NODE_NAME_MAX) return false;
  let hasAlnum = false;
  for (const ch of name) {
    if (/[\p{L}\p{N}]/u.test(ch)) {
      hasAlnum = true;
      continue;
    }
    if (ch === " " || ch === "." || ch === "_" || ch === "-") continue;
    return false;
  }
  return hasAlnum;
}

export function validHost(raw: string): boolean {
  const host = raw.trim();
  if (!host || host.length > HOST_MAX) return false;
  if (/[\s/?#@]/.test(host) || host.includes("://")) return false;
  if (host.startsWith("[") && host.endsWith("]")) return isIP(host.slice(1, -1));
  if (isIP(host)) return true;
  return validHostname(host);
}

export function validCidrs(raw: string): boolean {
  const text = raw.trim();
  if (!text) return true;
  const parts = text.split(/[,\s]+/).filter(Boolean);
  if (!parts.length) return true;
  return parts.every(validCidrOrIP);
}

function validCidrOrIP(part: string): boolean {
  if (!part.includes("/")) return isIP(part);
  const slash = part.lastIndexOf("/");
  const addr = part.slice(0, slash);
  const bits = part.slice(slash + 1);
  if (!/^\d{1,3}$/.test(bits)) return false;
  const n = Number(bits);
  if (isIPv4(addr)) return n <= 32;
  if (isIPv6(addr)) return n <= 128;
  return false;
}

function validHostname(host: string): boolean {
  const name = host.endsWith(".") ? host.slice(0, -1) : host;
  if (!name || name.length > HOST_MAX) return false;
  return name.split(".").every(validHostLabel);
}

function validHostLabel(label: string): boolean {
  if (label.length < 1 || label.length > LABEL_MAX) return false;
  return /^[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?$/.test(label);
}

function isIP(value: string): boolean {
  return isIPv4(value) || isIPv6(value);
}

function isIPv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    return n <= 255 && String(n) === part;
  });
}

function isIPv6(value: string): boolean {
  if (!value.includes(":")) return false;
  try {
    void new URL(`http://[${value}]`);
    return true;
  } catch {
    return false;
  }
}
