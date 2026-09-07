"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/lib/i18n";
import { authErrorMessage } from "@/lib/umbra/auth-error";
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
  const { t } = useI18n();
  const qc = useQueryClient();
  const owner = useQuery({ queryKey: ["umbra", "owner"], queryFn: () => getOwnerStatus() });
  const s = owner.data;
  if (!s?.required) return null;

  return (
    <section className="rounded-xl bg-card p-5 shadow-border">
      <p className="text-xs font-medium text-pine">{t("auth.kicker")}</p>
      <h2 className="mt-1 text-base font-medium text-ink">{t("auth.title")}</h2>
      <p className="mt-1 text-sm leading-relaxed text-stone">
        {s.twoFactorRequired ? t("auth.required") : t("auth.optional")}
      </p>
      {s.twoFactorConfigured ? (
        <p className="mt-2 text-sm text-ink">
          {t("auth.remaining", { n: s.recoveryRemaining ?? 0 })}
        </p>
      ) : null}
      <div className="mt-4 grid gap-6 lg:grid-cols-2">
        <PasswordForm
          needSecond={Boolean(s.twoFactorConfigured)}
          onDone={() => qc.invalidateQueries({ queryKey: ["umbra"] })}
        />
        {s.twoFactorRequired && s.twoFactorConfigured ? (
          <TwoFactorManage
            remaining={s.recoveryRemaining ?? 0}
            onDone={() => qc.invalidateQueries({ queryKey: ["umbra"] })}
          />
        ) : null}
      </div>
    </section>
  );
}

function PasswordForm({ needSecond, onDone }: { needSecond: boolean; onDone: () => void }) {
  const { t } = useI18n();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [totp, setTotp] = useState("");
  const mut = useMutation({
    mutationFn: () =>
      changeOwnerPassword({
        data: { current, new: next, totp: needSecond ? totp : undefined },
      }),
    onSuccess: () => {
      toast.success(t("auth.passwordUpdated"));
      setCurrent("");
      setNext("");
      setTotp("");
      onDone();
    },
    onError: (e: Error) => toast.error(authErrorMessage(e, needSecond ? "totp" : "password")),
  });
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        mut.mutate();
      }}
    >
      <h3 className="text-sm font-medium text-ink">{t("auth.changePassword")}</h3>
      <label className="flex flex-col gap-1.5">
        <Label>{t("auth.currentPassword")}</Label>
        <Input
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <Label>{t("auth.newPassword")}</Label>
        <Input
          type="password"
          autoComplete="new-password"
          minLength={8}
          value={next}
          onChange={(e) => setNext(e.target.value)}
          required
        />
      </label>
      {needSecond ? (
        <label className="flex flex-col gap-1.5">
          <Label>{t("auth.currentCode")}</Label>
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
        {mut.isPending ? t("common.loading") : t("auth.updatePassword")}
      </Button>
    </form>
  );
}

function TwoFactorManage({ remaining, onDone }: { remaining: number; onDone: () => void }) {
  const { t } = useI18n();
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
      toast.success(t("auth.codesReady"));
      onDone();
    },
    onError: (e: Error) => toast.error(authErrorMessage(e, "totp")),
  });
  const startReplace = useMutation({
    mutationFn: () => replaceTwoFactor({ data: { password, totp } }),
    onSuccess: async () => {
      const view = await getTwoFactorEnrollment();
      setEnroll(view);
      setCode("");
    },
    onError: (e: Error) => toast.error(authErrorMessage(e, "totp")),
  });
  const confirm = useMutation({
    mutationFn: () => confirmTwoFactorEnrollment({ data: { code } }),
    onSuccess: (res) => {
      setEnroll(null);
      setCodes(res.recoveryCodes);
      setPassword("");
      setTotp("");
      toast.success(t("auth.replaced"));
      onDone();
    },
    onError: (e: Error) => toast.error(authErrorMessage(e, "enrollment")),
  });

  if (codes) {
    return (
      <div>
        <h3 className="text-sm font-medium text-ink">{t("auth.newCodes")}</h3>
        <ul className="mt-2 space-y-1 font-mono text-sm">
          {codes.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <div className="mt-3 flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => downloadRecoveryCodes(codes)}
          >
            {t("common.download")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={async () => {
              await copyText(codes.join("\n"));
              toast.success(t("common.copied"));
            }}
          >
            {t("common.copy")}
          </Button>
          <Button type="button" size="sm" onClick={() => setCodes(null)}>
            {t("common.done")}
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
        <h3 className="text-sm font-medium text-ink">{t("auth.scanNew")}</h3>
        {enroll.qrPng ? (
          <img
            alt={t("login.qrAlt")}
            className="size-36 rounded-md bg-white p-2"
            src={`data:image/png;base64,${enroll.qrPng}`}
          />
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
          {confirm.isPending ? t("common.loading") : t("auth.confirmReplace")}
        </Button>
      </form>
    );
  }

  return (
    <form className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-ink">{t("auth.manageTitle")}</h3>
      <p className="text-xs text-stone">{t("auth.manageHint", { n: remaining })}</p>
      <label className="flex flex-col gap-1.5">
        <Label>{t("login.password")}</Label>
        <Input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <Label>{t("auth.currentCode")}</Label>
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
        <Button
          type="button"
          variant="outline"
          disabled={regen.isPending}
          onClick={() => regen.mutate()}
        >
          {regen.isPending ? t("common.loading") : t("auth.regen")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={startReplace.isPending}
          onClick={() => startReplace.mutate()}
        >
          {startReplace.isPending ? t("common.loading") : t("auth.replace")}
        </Button>
      </div>
    </form>
  );
}
