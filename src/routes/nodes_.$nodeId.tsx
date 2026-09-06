import { createFileRoute } from "@tanstack/react-router";
import { MappingsPage } from "@/components/pages/mappings-page";

export const Route = createFileRoute("/nodes_/$nodeId")({
  validateSearch: (raw: Record<string, unknown>): { service?: string; create?: boolean } => ({
    service: typeof raw.service === "string" && raw.service.trim() ? raw.service.trim() : undefined,
    create: raw.create === true || raw.create === "true" || raw.create === "1" ? true : undefined,
  }),
  component: NodeServicesPage,
});

function NodeServicesPage() {
  const { nodeId } = Route.useParams();
  return <MappingsPage key={nodeId} nodeId={nodeId} />;
}
