import { createFileRoute } from "@tanstack/react-router";
import { TrafficPage } from "@/components/pages/traffic-page";
import { parseTrafficSearch } from "@/lib/umbra/traffic-scope";

export const Route = createFileRoute("/traffic")({
  validateSearch: parseTrafficSearch,
  component: TrafficPage,
});
