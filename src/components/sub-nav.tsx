"use client";

import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Pattern A: top-level sections use the masthead nav.
 * Pattern B: in-page secondary location uses this underline sub-nav
 * (Observe, Settings, service detail).
 */
export type SubNavItem = {
  key: string;
  label: string;
  current: boolean;
  to?: string;
  search?: Record<string, unknown>;
  onSelect?: () => void;
};

export function SubNav({
  label,
  items,
  trailing,
}: {
  label: string;
  items: SubNavItem[];
  trailing?: ReactNode;
}) {
  return (
    <div className="sub-nav-bar">
      <nav aria-label={label} className="sub-nav">
        {items.map((item) =>
          item.to ? (
            <Link
              key={item.key}
              to={item.to as "/"}
              search={item.search}
              aria-current={item.current ? "page" : undefined}
              className={cn("sub-nav-item", item.current && "is-current")}
            >
              {item.label}
            </Link>
          ) : (
            <button
              key={item.key}
              type="button"
              aria-current={item.current ? "page" : undefined}
              className={cn("sub-nav-item", item.current && "is-current")}
              onClick={item.onSelect}
            >
              {item.label}
            </button>
          ),
        )}
      </nav>
      {trailing}
    </div>
  );
}
