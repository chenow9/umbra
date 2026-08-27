import { createFileRoute } from "@tanstack/react-router";
import { DeployPage } from "@/components/pages/deploy-page";

export const Route = createFileRoute("/deploy")({ component: DeployPage });
