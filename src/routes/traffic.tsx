import { createFileRoute } from "@tanstack/react-router";
import { TrafficPage } from "@/components/pages/traffic-page";

export const Route = createFileRoute("/traffic")({ component: TrafficPage });
