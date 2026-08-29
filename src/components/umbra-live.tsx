"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { applyLiveEvent, LiveStatusCtx } from "@/lib/umbra/live";
import { getOwnerStatus } from "@/lib/umbra/api";
import type { LiveEvent } from "@/lib/umbra/types";

export function UmbraLive({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const owner = useQuery({ queryKey: ["umbra", "owner"], queryFn: () => getOwnerStatus() });
  const enabled = Boolean(owner.data && (!owner.data.required || owner.data.signedIn));

  useEffect(() => {
    if (!enabled) {
      setConnected(false);
      return;
    }
    const es = new EventSource("/v1/events");
    es.addEventListener("live", (e: MessageEvent<string>) => {
      setConnected(true);
      try {
        applyLiveEvent(qc, JSON.parse(e.data) as LiveEvent);
      } catch {
        /* ignore malformed frames */
      }
    });
    es.onerror = () => setConnected(false);
    return () => {
      es.close();
      setConnected(false);
    };
  }, [qc, enabled]);

  return <LiveStatusCtx.Provider value={{ connected }}>{children}</LiveStatusCtx.Provider>;
}
