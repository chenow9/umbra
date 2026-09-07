import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import type { TrafficSearch } from "@/lib/umbra/traffic-scope";
import type { ReactNode } from "react";
export function ObservabilityNav({
  active,
  actions,
  trafficSearch,
}: {
  active: "traffic" | "audit";
  actions?: ReactNode;
  trafficSearch?: TrafficSearch;
}) {
  const { t } = useI18n();
  return (
    <div className="observation-viewbar">
      <nav aria-label={t("observe.views")} className="flex shrink-0 gap-1">
        {(
          [
            { key: "traffic", to: "/traffic", label: t("observe.traffic") },
            { key: "audit", to: "/audit", label: t("observe.audit") },
          ] as const
        ).map((item) => (
          <Link
            key={item.key}
            to={item.to}
            search={item.key === "traffic" ? trafficSearch : undefined}
            aria-current={active === item.key ? "page" : undefined}
            className={cn(
              "border-b-2 px-4 py-3 text-sm",
              active === item.key
                ? "border-pine font-medium text-ink"
                : "border-transparent text-stone hover:text-ink",
            )}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      {actions}
    </div>
  );
}
