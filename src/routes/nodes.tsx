import { createFileRoute } from "@tanstack/react-router";
import { NodesPage } from "@/components/pages/nodes-page";

export const Route = createFileRoute("/nodes")({ component: NodesPage });
