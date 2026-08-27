"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  getOwnerStatus,
  loginOwnerPassword,
  setupOwnerPassword,
} from "@/lib/umbra/api";

export function LoginPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["umbra", "owner"], queryFn: () => getOwnerStatus() });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const setup = useMutation({
    mutationFn: () => setupOwnerPassword({ data: { password } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["umbra"] });
      toast.success("口令已设定");
      await nav({ to: "/" });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const login = useMutation({
    mutationFn: () => loginOwnerPassword({ data: { password } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["umbra"] });
      await nav({ to: "/" });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const s = status.data;
  if (status.isLoading) return <div className="min-h-screen bg-paper" />;
  if (s && (!s.required || s.signedIn)) return <Navigate to="/" />;

  const configuring = s && !s.configured;
  const busy = setup.isPending || login.isPending;

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-4 text-ink">
      <section className="w-full max-w-md rounded-xl bg-card p-7 shadow-border">
        <p className="font-serif text-3xl italic tracking-tight">幽门</p>
        <p className="mt-1 text-xs tracking-[0.18em] text-stone uppercase">umbra</p>
        <h1 className="mt-6 text-base font-medium">
          {configuring ? "设定控制台口令" : "登录"}
        </h1>
        <p className="mt-1 text-sm leading-relaxed text-stone">
          {configuring
            ? "第一次打开。口令只存在这台机器上，没有默认密码，也不走互联网账号。"
            : "控制台和 API 共用这个口。节点走另一条控制通道。"}
        </p>
        <form
          className="mt-5 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy) return;
            if (configuring) {
              if (password !== confirm) {
                toast.error("两次口令不一致");
                return;
              }
              setup.mutate();
              return;
            }
            login.mutate();
          }}
        >
          <label className="flex flex-col gap-1.5">
            <Label>{configuring ? "新口令" : "口令"}</Label>
            <Input
              type="password"
              autoFocus
              autoComplete={configuring ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={configuring ? 8 : 1}
              required
            />
          </label>
          {configuring ? (
            <label className="flex flex-col gap-1.5">
              <Label>再输入一次</Label>
              <Input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                minLength={8}
                required
              />
            </label>
          ) : null}
          <div className="mt-2 flex justify-end">
            <Button type="submit" disabled={busy || password.length < (configuring ? 8 : 1)}>
              {busy ? "…" : configuring ? "设定并进入" : "进入"}
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}
