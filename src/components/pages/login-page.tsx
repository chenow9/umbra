"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate } from "@tanstack/react-router";
import { useEffect, useReducer, useState, type ReactNode } from "react";
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
import { useI18n } from "@/lib/i18n";
import { AuthLayout } from "@/components/auth-layout";
import { authErrorMessage, enrollmentNeedsLogin, type AuthFactor } from "@/lib/umbra/auth-error";

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
  | { type: "resetCodes" }
  | { type: "resetEnrollment" };

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
    case "resetEnrollment":
      return { ...initial };
    case "resetCodes":
      return { ...state, recoveryCodes: null, saved: false };
    default:
      return state;
  }
}

export function LoginPage() {
  const { t, locale } = useI18n();
  const nav = useNavigate();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["umbra", "owner"], queryFn: () => getOwnerStatus() });
  const [state, dispatch] = useReducer(reduce, initial);
  const s = status.data;
  const [failure, setFailure] = useState<{
    error: unknown;
    factor: AuthFactor;
  } | null>(null);
  const [mismatch, setMismatch] = useState(false);
  const fail = (error: unknown, factor: AuthFactor = "password") => setFailure({ error, factor });
  const clearFailure = () => {
    setFailure(null);
    setMismatch(false);
  };
  const returnToLogin = () => {
    dispatch({ type: "resetEnrollment" });
    clearFailure();
    void qc.invalidateQueries({ queryKey: ["umbra", "owner"] });
  };

  const showEnrollment = async () => {
    try {
      const view = await getTwoFactorEnrollment();
      dispatch({ type: "enroll", value: view });
      return true;
    } catch (e) {
      fail(e);
      await qc.invalidateQueries({ queryKey: ["umbra", "owner"] });
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
      .catch((error) => {
        if (!cancelled && !enrollmentNeedsLogin(error)) setFailure({ error, factor: "password" });
      });
    return () => {
      cancelled = true;
    };
  }, [s, state.recoveryCodes, state.enroll]);

  const setup = useMutation({
    onMutate: clearFailure,
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
    },
    onError: (e: Error) => fail(e),
  });

  const login = useMutation({
    onMutate: clearFailure,
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
    onError: (e: Error) =>
      fail(
        e,
        s?.twoFactorRequired && s?.twoFactorConfigured
          ? state.useRecovery
            ? "recovery"
            : "totp"
          : "password",
      ),
  });

  const confirm = useMutation({
    onMutate: clearFailure,
    mutationFn: () => confirmTwoFactorEnrollment({ data: { code: state.enrollCode } }),
    onSuccess: async (res) => {
      dispatch({ type: "codes", value: res.recoveryCodes });
      await qc.invalidateQueries({ queryKey: ["umbra", "owner"] });
    },
    onError: (e: Error) => fail(e, "enrollment"),
  });

  if (status.isLoading)
    return (
      <AuthLayout>
        <p role="status" className="text-sm text-stone">
          {t("login.loading")}
        </p>
      </AuthLayout>
    );
  if (status.isError || !s)
    return (
      <AuthLayout>
        <h1>{t("login.statusError")}</h1>
        <p role="alert" className="mt-3 text-sm leading-relaxed text-stone">
          {t("login.statusErrorHint")}
        </p>
        <Button className="mt-6" disabled={status.isFetching} onClick={() => void status.refetch()}>
          {t("login.retry")}
        </Button>
      </AuthLayout>
    );
  if (s && (!s.required || (s.signedIn && !state.recoveryCodes))) return <Navigate to="/" />;

  const phase: Phase = state.recoveryCodes
    ? "recovery"
    : s?.next === "enroll_2fa" && state.enroll
      ? "enroll"
      : "form";
  const configuring = s && !s.configured;
  const busy = setup.isPending || login.isPending || confirm.isPending;

  return (
    <AuthLayout>
      {(configuring && s.twoFactorRequired) || phase !== "form" ? (
        <ol className="auth-steps" aria-label={t("login.steps")}>
          {["stepPassword", "stepVerify", "stepRecovery"].map((key, i) => (
            <li
              key={key}
              aria-current={
                i === (phase === "recovery" ? 2 : phase === "enroll" ? 1 : 0) ? "step" : undefined
              }
            >
              {t(`login.${key}`)}
            </li>
          ))}
        </ol>
      ) : null}
      {failure || mismatch ? (
        <div className="auth-alert" role="alert">
          {mismatch
            ? t("login.mismatch")
            : authErrorMessage(failure?.error, failure?.factor, locale)}
          {enrollmentNeedsLogin(failure?.error) ? (
            <button type="button" className="mt-2 block underline" onClick={returnToLogin}>
              {t("login.backToLogin")}
            </button>
          ) : null}
        </div>
      ) : null}
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
          requireTwoFactor={s.twoFactorRequired}
          state={state}
          busy={busy}
          dispatch={(action) => {
            clearFailure();
            dispatch(action);
          }}
          onSubmit={() => {
            if (configuring) {
              if (state.password !== state.confirm) {
                setMismatch(true);
                return;
              }
              setup.mutate();
              return;
            }
            login.mutate();
          }}
        />
      )}
    </AuthLayout>
  );
}

function AuthForm({
  configuring,
  migration,
  twoFactor,
  requireTwoFactor,
  state,
  busy,
  dispatch,
  onSubmit,
}: {
  configuring: boolean;
  migration: boolean;
  twoFactor: boolean;
  requireTwoFactor: boolean;
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
    (!needSecond ||
      (state.useRecovery ? state.recovery.trim().length > 0 : state.totp.length === 6));

  return (
    <>
      <h1 className="mt-6 text-base font-medium">
        {configuring
          ? t("login.setupTitle")
          : migration
            ? t("login.migrateTitle")
            : t("login.title")}
      </h1>
      {configuring ? (
        <p className="mt-1 text-sm leading-relaxed text-stone">
          {t(requireTwoFactor ? "login.setupHint" : "login.setupPasswordOnlyHint")}
        </p>
      ) : migration ? (
        <p className="mt-1 text-sm leading-relaxed text-stone">
          {t("login.migrateHintPrefix")} <span className="font-mono text-ink">2fa-bootstrap</span>{" "}
          {t("login.migrateHintSuffix")}
        </p>
      ) : (
        <p className="mt-3 text-sm leading-relaxed text-stone">
          {t(
            needSecond
              ? state.useRecovery
                ? "login.signInRecoveryHint"
                : "login.signInTwoFactorHint"
              : "login.signInHint",
          )}
        </p>
      )}
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
            placeholder={configuring ? t("login.passwordHint") : undefined}
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
              onChange={(e) =>
                dispatch({
                  type: "field",
                  key: "totp",
                  value: e.target.value.replace(/\D/g, "").slice(0, 6),
                })
              }
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
            onClick={() =>
              dispatch({ type: "field", key: "useRecovery", value: !state.useRecovery })
            }
          >
            {state.useRecovery ? t("login.useTotp") : t("login.useRecovery")}
          </button>
        ) : null}
        <div className="mt-2 flex justify-end">
          <Button type="submit" disabled={busy || !canSubmit}>
            {busy
              ? t("common.loading")
              : configuring
                ? t(requireTwoFactor ? "login.setupSubmit" : "login.setupPasswordOnlySubmit")
                : t("login.submit")}
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
      <details className="auth-secret">
        <summary>{t("login.manualSecret")}</summary>
        <p className="mt-3 break-all font-mono text-xs leading-relaxed text-ink">{enroll.secret}</p>
        <div className="mt-2 flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={async () => {
              try {
                await copyText(enroll.secret);
                toast.success(t("login.secretCopied"));
              } catch {
                toast.error(t("login.copyFailed"));
              }
            }}
          >
            {t("login.copySecret")}
          </Button>
        </div>
      </details>
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
      <ul className="auth-recovery-codes mt-4 font-mono text-ink">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => downloadRecoveryCodes(codes)}
        >
          {t("login.downloadTxt")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={async () => {
            try {
              await copyText(codes.join("\n"));
              toast.success(t("login.codesCopied"));
            } catch {
              toast.error(t("login.copyFailed"));
            }
          }}
        >
          {t("login.copyAll")}
        </Button>
      </div>
      <label className="mt-4 flex items-start gap-2 text-sm text-ink">
        <input
          type="checkbox"
          className="mt-1"
          checked={saved}
          onChange={(e) => onSaved(e.target.checked)}
        />
        {t("login.savedConfirm")}
      </label>
      <div className="mt-4 flex justify-end">
        <Button className="w-full" type="button" disabled={!saved || busy} onClick={() => onDone()}>
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
