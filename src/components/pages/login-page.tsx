"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate } from "@tanstack/react-router";
import { useEffect, useReducer, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  confirmTwoFactorEnrollment,
  getOwnerStatus,
  getTwoFactorEnrollment,
  loginOwnerPassword,
  setupOwnerPassword,
  type TwoFactorEnrollment,
} from "@/lib/umbra/api";
import { copyText, downloadRecoveryCodes } from "@/lib/umbra/recovery-file";
import { t as translate, useI18n } from "@/lib/i18n";

type Phase = "form" | "enroll" | "recovery";

type State = {
  password: string;
  confirm: string;
  totp: string;
  recovery: string;
  migration: string;
  useRecovery: boolean;
  enroll: TwoFactorEnrollment | null;
  recoveryCodes: string[] | null;
  saved: boolean;
  enrollCode: string;
};

type Action =
  | { type: "field"; key: keyof State; value: string | boolean }
  | { type: "enroll"; value: TwoFactorEnrollment }
  | { type: "codes"; value: string[] }
  | { type: "resetCodes" };

const initial: State = {
  password: "",
  confirm: "",
  totp: "",
  recovery: "",
  migration: "",
  useRecovery: false,
  enroll: null,
  recoveryCodes: null,
  saved: false,
  enrollCode: "",
};

function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "field":
      return { ...state, [action.key]: action.value };
    case "enroll":
      return { ...state, enroll: action.value, enrollCode: "" };
    case "codes":
      return { ...state, recoveryCodes: action.value, saved: false };
    case "resetCodes":
      return { ...state, recoveryCodes: null, saved: false };
    default:
      return state;
  }
}

export function LoginPage() {
  const { t } = useI18n();
  const nav = useNavigate();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["umbra", "owner"], queryFn: () => getOwnerStatus() });
  const [state, dispatch] = useReducer(reduce, initial);
  const s = status.data;

  const showEnrollment = async () => {
    try {
      const view = await getTwoFactorEnrollment();
      dispatch({ type: "enroll", value: view });
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("login.enrollLoadFail"));
      return false;
    }
  };

  useEffect(() => {
    if (!s || s.next !== "enroll_2fa" || s.signedIn || state.recoveryCodes || state.enroll) return;
    let cancelled = false;
    getTwoFactorEnrollment()
      .then((view) => {
        if (!cancelled) dispatch({ type: "enroll", value: view });
      })
      .catch(() => {
        /* 预认证过期时回到口令表单 */
      });
    return () => {
      cancelled = true;
    };
  }, [s, state.recoveryCodes, state.enroll]);

  const setup = useMutation({
    mutationFn: () => setupOwnerPassword({ data: { password: state.password } }),
    onSuccess: async (res) => {
      if (res.next === "authenticated") {
        await qc.invalidateQueries({ queryKey: ["umbra", "owner"] });
        await nav({ to: "/" });
        return;
      }
      if (res.next === "enroll_2fa") {
        if (!(await showEnrollment())) return;
      }
      void qc.invalidateQueries({ queryKey: ["umbra", "owner"] });
      toast.success(t("login.passwordSet"));
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const login = useMutation({
    mutationFn: () =>
      loginOwnerPassword({
        data: {
          password: state.password,
          totp: state.useRecovery ? undefined : state.totp || undefined,
          recoveryCode: state.useRecovery ? state.recovery || undefined : undefined,
          migrationCode: s?.migrationProofRequired ? state.migration || undefined : undefined,
        },
      }),
    onSuccess: async (res) => {
      if (res.next === "authenticated") {
        await qc.invalidateQueries({ queryKey: ["umbra"] });
        await nav({ to: "/" });
        return;
      }
      if (res.next === "enroll_2fa") {
        // 迁移用户在登录前后看到的 /v1/auth 内容相同。React Query 会
        // 结构共享同一个对象，因此依赖 status 变化的 effect 不会重跑。
        // 预认证 cookie 已由 /v1/login 写入，直接读取 enrollment 才能
        // 无需刷新就进入二维码步骤。
        if (!(await showEnrollment())) return;
      }
      void qc.invalidateQueries({ queryKey: ["umbra"] });
      dispatch({ type: "resetCodes" });
    },
    onError: (e: Error) => toast.error(hintAuthError(e.message)),
  });

  const confirm = useMutation({
    mutationFn: () => confirmTwoFactorEnrollment({ data: { code: state.enrollCode } }),
    onSuccess: async (res) => {
      dispatch({ type: "codes", value: res.recoveryCodes });
      await qc.invalidateQueries({ queryKey: ["umbra", "owner"] });
    },
    onError: (e: Error) => toast.error(hintAuthError(e.message)),
  });

  if (status.isLoading) return <div className="min-h-screen bg-paper" />;
  if (s && (!s.required || (s.signedIn && !state.recoveryCodes))) return <Navigate to="/" />;

  const phase: Phase = state.recoveryCodes
    ? "recovery"
    : s?.next === "enroll_2fa" && state.enroll
      ? "enroll"
      : "form";
  const configuring = s && !s.configured;
  const busy = setup.isPending || login.isPending || confirm.isPending;

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-4 text-ink">
      <section className="w-full max-w-md rounded-xl bg-card p-7 shadow-border">
        <p className="font-serif text-3xl italic tracking-tight">umbra</p>
        <p className="mt-3 text-xs text-stone">{t("login.tagline")}</p>
        {phase === "recovery" && state.recoveryCodes ? (
          <RecoveryStep
            codes={state.recoveryCodes}
            saved={state.saved}
            busy={busy}
            onSaved={(v) => dispatch({ type: "field", key: "saved", value: v })}
            onDone={async () => {
              await qc.invalidateQueries({ queryKey: ["umbra"] });
              await nav({ to: "/" });
            }}
          />
        ) : phase === "enroll" && state.enroll ? (
          <EnrollStep
            enroll={state.enroll}
            code={state.enrollCode}
            busy={busy}
            onCode={(v) => dispatch({ type: "field", key: "enrollCode", value: v })}
            onSubmit={() => confirm.mutate()}
          />
        ) : (
          <AuthForm
            configuring={Boolean(configuring)}
            migration={Boolean(s?.migrationProofRequired)}
            twoFactor={Boolean(s?.twoFactorRequired && s?.twoFactorConfigured)}
            state={state}
            busy={busy}
            dispatch={dispatch}
            onSubmit={() => {
              if (configuring) {
                if (state.password !== state.confirm) {
                  toast.error(t("login.mismatch"));
                  return;
                }
                setup.mutate();
                return;
              }
              login.mutate();
            }}
          />
        )}
      </section>
    </div>
  );
}

function hintAuthError(message: string) {
  if (message.includes("认证凭证不正确")) {
    return `${message}${translate("login.clockHint")}`;
  }
  return message;
}

function AuthForm({
  configuring,
  migration,
  twoFactor,
  state,
  busy,
  dispatch,
  onSubmit,
}: {
  configuring: boolean;
  migration: boolean;
  twoFactor: boolean;
  state: State;
  busy: boolean;
  dispatch: (a: Action) => void;
  onSubmit: () => void;
}) {
  const { t } = useI18n();
  const needSecond = twoFactor && !configuring;
  const minLen = configuring ? 8 : 1;
  const canSubmit =
    state.password.length >= minLen &&
    (!configuring || state.confirm.length >= 8) &&
    (!migration || state.migration.trim().length > 0) &&
    (!needSecond || (state.useRecovery ? state.recovery.trim().length > 0 : state.totp.length === 6));

  return (
    <>
      <h1 className="mt-6 text-base font-medium">
        {configuring ? t("login.setupTitle") : migration ? t("login.migrateTitle") : t("login.title")}
      </h1>
      {configuring ? (
        <p className="mt-1 text-sm leading-relaxed text-stone">{t("login.setupHint")}</p>
      ) : migration ? (
        <p className="mt-1 text-sm leading-relaxed text-stone">
          {t("login.migrateHintPrefix")} <span className="font-mono text-ink">2fa-bootstrap</span>{" "}
          {t("login.migrateHintSuffix")}
        </p>
      ) : null}
      <form
        className="mt-5 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (busy || !canSubmit) return;
          onSubmit();
        }}
      >
        <Field label={configuring ? t("login.newPassword") : t("login.password")}>
          <Input
            type="password"
            autoFocus
            autoComplete={configuring ? "new-password" : "current-password"}
            value={state.password}
            onChange={(e) => dispatch({ type: "field", key: "password", value: e.target.value })}
            minLength={configuring ? 8 : 1}
            required
          />
        </Field>
        {configuring ? (
          <Field label={t("login.confirmPassword")}>
            <Input
              type="password"
              autoComplete="new-password"
              value={state.confirm}
              onChange={(e) => dispatch({ type: "field", key: "confirm", value: e.target.value })}
              minLength={8}
              required
            />
          </Field>
        ) : null}
        {migration ? (
          <Field label={t("login.migrationCode")}>
            <Input
              autoComplete="off"
              spellCheck={false}
              value={state.migration}
              onChange={(e) => dispatch({ type: "field", key: "migration", value: e.target.value })}
              required
            />
          </Field>
        ) : null}
        {needSecond && !state.useRecovery ? (
          <Field label={t("login.totp")}>
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              value={state.totp}
              onChange={(e) => dispatch({ type: "field", key: "totp", value: e.target.value.replace(/\D/g, "").slice(0, 6) })}
              required
            />
          </Field>
        ) : null}
        {needSecond && state.useRecovery ? (
          <Field label={t("login.recovery")}>
            <Input
              autoComplete="off"
              spellCheck={false}
              value={state.recovery}
              onChange={(e) => dispatch({ type: "field", key: "recovery", value: e.target.value })}
              required
            />
          </Field>
        ) : null}
        {needSecond ? (
          <button
            type="button"
            className="self-start text-xs text-pine hover:underline"
            onClick={() => dispatch({ type: "field", key: "useRecovery", value: !state.useRecovery })}
          >
            {state.useRecovery ? t("login.useTotp") : t("login.useRecovery")}
          </button>
        ) : null}
        <div className="mt-2 flex justify-end">
          <Button type="submit" disabled={busy || !canSubmit}>
            {busy ? t("common.loading") : configuring ? t("login.setupSubmit") : t("login.submit")}
          </Button>
        </div>
      </form>
    </>
  );
}

function EnrollStep({
  enroll,
  code,
  busy,
  onCode,
  onSubmit,
}: {
  enroll: TwoFactorEnrollment;
  code: string;
  busy: boolean;
  onCode: (v: string) => void;
  onSubmit: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <h1 className="mt-6 text-base font-medium">{t("login.enrollTitle")}</h1>
      <p className="mt-1 text-sm leading-relaxed text-stone">{t("login.enrollHint")}</p>
      {enroll.qrPng ? (
        <img
          alt={t("login.qrAlt")}
          className="mx-auto mt-4 size-44 rounded-md bg-white p-2"
          src={`data:image/png;base64,${enroll.qrPng}`}
        />
      ) : null}
      <p className="mt-3 break-all font-mono text-xs leading-relaxed text-ink">{enroll.secret}</p>
      <div className="mt-2 flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={async () => {
            await copyText(enroll.secret);
            toast.success(t("login.secretCopied"));
          }}
        >
          {t("login.copySecret")}
        </Button>
      </div>
      <form
        className="mt-5 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (busy || code.length !== 6) return;
          onSubmit();
        }}
      >
        <Field label={t("login.sixDigit")}>
          <Input
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={6}
            value={code}
            onChange={(e) => onCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            required
          />
        </Field>
        <div className="mt-2 flex justify-end">
          <Button type="submit" disabled={busy || code.length !== 6}>
            {busy ? t("common.loading") : t("login.confirmBind")}
          </Button>
        </div>
      </form>
    </>
  );
}

function RecoveryStep({
  codes,
  saved,
  busy,
  onSaved,
  onDone,
}: {
  codes: string[];
  saved: boolean;
  busy: boolean;
  onSaved: (v: boolean) => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <h1 className="mt-6 text-base font-medium">{t("login.saveCodesTitle")}</h1>
      <p className="mt-1 text-sm leading-relaxed text-stone">{t("login.saveCodesHint")}</p>
      <ul className="mt-4 space-y-1 font-mono text-sm text-ink">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => downloadRecoveryCodes(codes)}>
          {t("login.downloadTxt")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={async () => {
            await copyText(codes.join("\n"));
            toast.success(t("login.codesCopied"));
          }}
        >
          {t("login.copyAll")}
        </Button>
      </div>
      <label className="mt-4 flex items-start gap-2 text-sm text-ink">
        <input type="checkbox" className="mt-1" checked={saved} onChange={(e) => onSaved(e.target.checked)} />
        {t("login.savedConfirm")}
      </label>
      <div className="mt-4 flex justify-end">
        <Button type="button" disabled={!saved || busy} onClick={() => onDone()}>
          {t("login.enterConsole")}
        </Button>
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
    </label>
  );
}
