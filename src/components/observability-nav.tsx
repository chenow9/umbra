import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
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
  return (
    <div className="observation-viewbar">
      <nav aria-label="观测视图" className="flex shrink-0 gap-1">
        {(
          [
            { key: "traffic", to: "/traffic", label: "流量" },
            { key: "audit", to: "/audit", label: "审计记录" },
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
