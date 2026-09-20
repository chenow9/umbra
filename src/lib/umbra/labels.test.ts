import test from "node:test";
import assert from "node:assert/strict";
import { auditTargetHint, auditTargetLabel } from "./labels.ts";

test("audit object column prefers a display name over raw ids", () => {
  assert.equal(
    auditTargetLabel({ target: "nde_abc", targetName: "nde_abc", detail: "home-nas linux/amd64" }),
    "home-nas",
  );
  assert.equal(
    auditTargetLabel({ target: "map_1", targetName: "工作室 SSH · lab", detail: "" }),
    "工作室 SSH · lab",
  );
  assert.equal(auditTargetLabel({ target: "nde_abc", detail: "" }), "nde_abc");
  assert.equal(auditTargetHint({ target: "nde_abc", targetName: "home-nas" }), "nde_abc");
});
