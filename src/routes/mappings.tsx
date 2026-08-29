import { createFileRoute } from "@tanstack/react-router";
import { MappingsPage } from "@/components/pages/mappings-page";

export type MappingsSearch = {
  node?: string;
};

export const Route = createFileRoute("/mappings")({
  validateSearch: (raw: Record<string, unknown>): MappingsSearch => ({
    node: typeof raw.node === "string" && raw.node.trim() ? raw.node.trim() : undefined,
  }),
  component: MappingsPage,
});
