import { SubNav } from "@/components/sub-nav";
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
    <SubNav
      label={t("observe.views")}
      trailing={actions}
      items={[
        {
          key: "traffic",
          to: "/traffic",
          search: trafficSearch,
          label: t("observe.traffic"),
          current: active === "traffic",
        },
        {
          key: "audit",
          to: "/audit",
          label: t("observe.audit"),
          current: active === "audit",
        },
      ]}
    />
  );
}
