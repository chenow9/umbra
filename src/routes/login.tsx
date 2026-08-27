import { createFileRoute } from "@tanstack/react-router";
import { LoginPage } from "@/components/pages/login-page";

export const Route = createFileRoute("/login")({ component: LoginPage });
