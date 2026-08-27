"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { runDemo } from "@/lib/umbra/api";

export function DemoButton({
  variant = "default",
  size = "lg",
  label = "跑一遍演示",
}: {
  variant?: "default" | "outline" | "ghost";
  size?: "default" | "lg" | "sm";
  label?: string;
}) {
  const qc = useQueryClient();
  const demo = useMutation({
    mutationFn: () => runDemo(),
    onMutate: () => {
      toast.loading("正在丢包、敲门并探测…", { id: "demo" });
    },
    onSuccess: (r) => {
      toast.success(
        r.dropped
          ? `未授权已丢弃，敲门后 TCP ${r.bytesIn}B · UDP ${r.udpBytesIn}B`
          : `TCP ${r.bytesIn}B · UDP ${r.udpBytesIn}B`,
        { id: "demo" },
      );
      void qc.invalidateQueries({ queryKey: ["umbra"] });
    },
    onError: (e: Error) => toast.error(e.message, { id: "demo" }),
  });

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      disabled={demo.isPending}
      aria-busy={demo.isPending}
      onClick={() => {
        if (demo.isPending) return;
        toast.loading("正在丢包、敲门并探测…", { id: "demo" });
        demo.mutate();
      }}
    >
      {demo.isPending ? "正在探测…" : label}
    </Button>
  );
}
