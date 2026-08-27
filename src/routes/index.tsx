import { createFileRoute } from "@tanstack/react-router";
import { OverviewPage } from "@/components/pages/overview-page";

export const Route = createFileRoute("/")({ component: OverviewPage });
