import { createHash, randomBytes } from "node:crypto";

export function newId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

export function newBootstrap() {
  return `umbra_boot_${randomBytes(18).toString("base64url")}`;
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function newVisitorTicket() {
  return `umbra_vis_${randomBytes(18).toString("base64url")}`;
}
