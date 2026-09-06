import { createFileRoute } from "@tanstack/react-router";
import { NodesPage } from "@/components/pages/nodes-page";

export const Route = createFileRoute("/nodes")({
  validateSearch: (raw: Record<string, unknown>): { edit?: string } => ({
    edit: typeof raw.edit === "string" ? raw.edit : undefined,
  }),
  component: NodesPage,
});
