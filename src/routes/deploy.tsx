import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/deploy")({
  beforeLoad: () => {
    throw redirect({ to: "/settings" });
  },
});
