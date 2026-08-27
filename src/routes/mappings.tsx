import { createFileRoute } from "@tanstack/react-router";
import { MappingsPage } from "@/components/pages/mappings-page";

export const Route = createFileRoute("/mappings")({ component: MappingsPage });
