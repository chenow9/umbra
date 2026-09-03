"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  changeOwnerPassword,
  confirmTwoFactorEnrollment,
  getOwnerStatus,
  getTwoFactorEnrollment,
  regenerateRecoveryCodes,
  replaceTwoFactor,
  type TwoFactorEnrollment,
} from "@/lib/umbra/api";
import { copyText, downloadRecoveryCodes } from "@/lib/umbra/recovery-file";

export function AuthPanel() {
  const qc = useQueryClient();
  const owner = useQuery({ queryKey: ["umbra", "owner"], queryFn: () => getOwnerStatus() });
  const s = owner.data;
  if (!s?.required) return null;

  return (
    <section className="rounded-xl bg-card p-5 shadow-border">
      <p className="text-xs font-medium text-pine">控制台认证</p>
      <h2 className="mt-1 text-base font-medium text-ink">口令与双因素</h2>
      <p className="mt-1 text-sm leading-relaxed text-stone">
        {s.twoFactorRequired
          ? "登录需要口令和 Authenticator 验证码。关闭 2FA 只能改环境变量，不能在网页上解绑。"
          : "当前 UMBRA_2FA=off，登录只验口令。已有绑定不会删除；重新开启后 password-only 会话会失效。"}
      </p>
      {s.twoFactorConfigured ? (
        <p className="mt-2 text-sm text-ink">剩余恢复码 {s.recoveryRemaining ?? 0} 个。</p>
      ) : null}
      <div className="mt-4 grid gap-6 lg:grid-cols-2">
        <PasswordForm needSecond={Boolean(s.twoFactorConfigured)} onDone={() => qc.invalidateQueries({ queryKey: ["umbra"] })} />
        {s.twoFactorRequired && s.twoFactorConfigured ? (
          <TwoFactorManage remaining={s.recoveryRemaining ?? 0} onDone={() => qc.invalidateQueries({ queryKey: ["umbra"] })} />
        ) : null}
      </div>
    </section>
  );
}

function PasswordForm({ needSecond, onDone }: { needSecond: boolean; onDone: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [totp, setTotp] = useState("");
  const mut = useMutation({
    mutationFn: () =>
      changeOwnerPassword({
        data: { current, new: next, totp: needSecond ? totp : undefined },
      }),
    onSuccess: () => {
      toast.success("口令已更新，其他会话已退出");
      setCurrent("");
      setNext("");
      setTotp("");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        mut.mutate();
      }}
    >
      <h3 className="text-sm font-medium text-ink">修改口令</h3>
      <label className="flex flex-col gap-1.5">
        <Label>当前口令</Label>
        <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </label>
      <label className="flex flex-col gap-1.5">
        <Label>新口令</Label>
        <Input type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required />
      </label>
      {needSecond ? (
        <label className="flex flex-col gap-1.5">
          <Label>当前验证码</Label>
          <Input
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={totp}
            onChange={(e) => setTotp(e.target.value.replace(/\D/g, "").slice(0, 6))}
            required
          />
        </label>
      ) : null}
      <Button type="submit" variant="outline" disabled={mut.isPending}>
        {mut.isPending ? "…" : "更新口令"}
      </Button>
    </form>
  );
}

function TwoFactorManage({ remaining, onDone }: { remaining: number; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [enroll, setEnroll] = useState<TwoFactorEnrollment | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);

  const regen = useMutation({
    mutationFn: () => regenerateRecoveryCodes({ data: { password, totp } }),
    onSuccess: (res) => {
      setCodes(res.recoveryCodes);
      setPassword("");
      setTotp("");
      toast.success("已生成新的恢复码");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const startReplace = useMutation({
    mutationFn: () => replaceTwoFactor({ data: { password, totp } }),
    onSuccess: async () => {
      const view = await getTwoFactorEnrollment();
      setEnroll(view);
      setCode("");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const confirm = useMutation({
    mutationFn: () => confirmTwoFactorEnrollment({ data: { code } }),
    onSuccess: (res) => {
      setEnroll(null);
      setCodes(res.recoveryCodes);
      setPassword("");
      setTotp("");
      toast.success("已更换 Authenticator");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (codes) {
    return (
      <div>
        <h3 className="text-sm font-medium text-ink">新的恢复码</h3>
        <ul className="mt-2 space-y-1 font-mono text-sm">
          {codes.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <div className="mt-3 flex gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => downloadRecoveryCodes(codes)}>
            下载
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={async () => {
              await copyText(codes.join("\n"));
              toast.success("已复制");
            }}
          >
            复制
          </Button>
          <Button type="button" size="sm" onClick={() => setCodes(null)}>
            完成
          </Button>
        </div>
      </div>
    );
  }

  if (enroll) {
    return (
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          confirm.mutate();
        }}
      >
        <h3 className="text-sm font-medium text-ink">扫描新的 Authenticator</h3>
        {enroll.qrPng ? (
          <img alt="TOTP 二维码" className="size-36 rounded-md bg-white p-2" src={`data:image/png;base64,${enroll.qrPng}`} />
        ) : null}
        <p className="break-all font-mono text-xs">{enroll.secret}</p>
        <Input
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          required
        />
        <Button type="submit" disabled={confirm.isPending || code.length !== 6}>
          {confirm.isPending ? "…" : "确认更换"}
        </Button>
      </form>
    );
  }

  return (
    <form className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-ink">更换绑定 / 重生恢复码</h3>
      <p className="text-xs text-stone">剩余 {remaining} 个恢复码。关闭 2FA 时这两项不可用。</p>
      <label className="flex flex-col gap-1.5">
        <Label>口令</Label>
        <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </label>
      <label className="flex flex-col gap-1.5">
        <Label>当前验证码</Label>
        <Input
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={totp}
          onChange={(e) => setTotp(e.target.value.replace(/\D/g, "").slice(0, 6))}
          required
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={regen.isPending} onClick={() => regen.mutate()}>
          {regen.isPending ? "…" : "重生恢复码"}
        </Button>
        <Button type="button" variant="outline" disabled={startReplace.isPending} onClick={() => startReplace.mutate()}>
          {startReplace.isPending ? "…" : "更换 Authenticator"}
        </Button>
      </div>
    </form>
  );
}
