import { createFileRoute } from "@tanstack/react-router";
import { SystemPage } from "@/components/pages/system-page";

export const Route = createFileRoute("/deploy")({ component: SystemPage });
