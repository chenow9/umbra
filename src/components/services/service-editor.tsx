"use client";
import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { SelectField, TextField } from "@/components/field";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import {
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetBody,
  SheetFooter,
  SheetClose,
} from "@/components/ui/sheet";
import { useI18n } from "@/lib/i18n";
import { listNodes, createMapping, updateMapping } from "@/lib/umbra/api";
import {
  formatRateDisplay,
  formatRateHint,
  pickRateUnit,
  RATE_UNITS,
  unitToKbps,
  type RateUnit,
} from "@/lib/umbra/format";
import type { Mapping, MappingMode, Proto } from "@/lib/umbra/types";
import { accessOptions, validateService } from "@/lib/umbra/service";
function RateLimitField({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const { t } = useI18n();
  const id = useId();
  const hintId = `${id}-hint`;
  const kbps = Number(value) || 0;
  const [unit, setUnit] = useState<RateUnit>(() => pickRateUnit(kbps));
  const [draft, setDraft] = useState(() => formatRateDisplay(kbps, pickRateUnit(kbps)));

  function commit(raw: string, nextUnit: RateUnit) {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed === "0") {
      onChange("0");
      setDraft(trimmed === "" ? "" : "0");
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0) return;
    const next = String(unitToKbps(n, nextUnit));
    onChange(next);
    setDraft(raw);
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{t("editor.rate")}</Label>
      <div className="flex h-11 min-w-0 overflow-hidden rounded-md bg-paper shadow-border focus-within:ring-2 focus-within:ring-pine/35">
        <Input
          id={id}
          inputMode="decimal"
          value={draft}
          aria-describedby={hintId}
          placeholder="0"
          className="h-11 rounded-none shadow-none focus-visible:ring-0"
          onChange={(e) => commit(e.target.value, unit)}
        />
        <Select
          aria-label={t("editor.rateUnit")}
          value={unit}
          onValueChange={(v) => {
            const next = v as RateUnit;
            setUnit(next);
            setDraft(formatRateDisplay(Number(value) || 0, next));
          }}
          options={RATE_UNITS.map((u) => ({ value: u.id, label: u.label }))}
          triggerClassName="w-auto shrink-0 rounded-none border-l border-line bg-paper-2 px-2 shadow-none focus-visible:ring-0"
        />
      </div>
      <p id={hintId} className="font-mono text-xs tabular-nums text-stone">
        {formatRateHint(Number(value) || 0)}
      </p>
    </div>
  );
}

export function ServiceEditor({
  mapping,
  defaultNodeId,
  onDone,
}: {
  mapping: Mapping | null;
  defaultNodeId?: string;
  onDone: (mapping: Mapping) => void;
}) {
  const { t } = useI18n();
  const nodes = useQuery({ queryKey: ["umbra", "nodes"], queryFn: () => listNodes() });
  const usable = (nodes.data ?? []).filter((a) => a.status !== "revoked");
  const [nodeId, setNodeId] = useState(mapping?.nodeId ?? defaultNodeId ?? "");
  const [name, setName] = useState(mapping?.name ?? "");
  const [proto, setProto] = useState<Proto>(mapping?.proto ?? "tcp");
  const [mode, setMode] = useState<MappingMode>(mapping?.mode ?? "visitor");
  const [entryPort, setEntryPort] = useState(String(mapping?.entryPort ?? ""));
  const [localHost, setLocalHost] = useState(mapping?.localHost ?? "127.0.0.1");
  const [localPort, setLocalPort] = useState(String(mapping?.localPort ?? ""));
  const [maxConns, setMaxConns] = useState(String(mapping?.maxConns ?? 1024));
  const [idleTimeout, setIdleTimeout] = useState(String(mapping?.idleTimeoutSec ?? 0));
  const [spaTtl, setSpaTtl] = useState(String(mapping?.spaTtlSec || 60));
  const [udpIdle, setUdpIdle] = useState(String(mapping?.udpIdleTimeoutSec || 60));
  const [rateKbps, setRateKbps] = useState(String(mapping?.rateKbps ?? 0));
  const [allowCidrs, setAllowCidrs] = useState(mapping?.allowCidrs ?? "");
  const selected =
    nodeId || usable.find((node) => node.status === "online")?.id || usable[0]?.id || "";
  const editing = mapping !== null;
  const [step, setStep] = useState(0);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!editing) stepHeading.current?.focus();
  }, [step, editing]);

  const payload = {
    nodeId: selected,
    name: name.trim(),
    proto,
    mode,
    entryPort: mode === "visitor" ? null : Number(entryPort),
    localHost: localHost.trim(),
    localPort: Number(localPort),
    maxConns: Number(maxConns),
    idleTimeoutSec: Number(idleTimeout),
    spaTtlSec: Number(spaTtl),
    udpIdleTimeoutSec: Number(udpIdle),
    rateKbps: Number(rateKbps),
    allowCidrs,
  };

  const validation = !usable.some((node) => node.id === selected)
    ? t("editor.invalidNode")
    : validateService(payload);

  const targetValidation = !usable.some((node) => node.id === selected)
    ? t("editor.invalidNode")
    : validateService({
        ...payload,
        mode: "visitor",
        entryPort: null,
        maxConns: 0,
        idleTimeoutSec: 0,
        spaTtlSec: 0,
        udpIdleTimeoutSec: 0,
        rateKbps: 0,
      });
  const stepValidation = !editing && step === 0 ? targetValidation : validation;
  const stepTitles = [t("editor.where"), t("editor.who"), t("editor.confirm")];

  const save = useMutation({
    mutationFn: () =>
      editing
        ? updateMapping({ data: { id: mapping.id, ...payload } })
        : createMapping({ data: payload }),
    onSuccess: (m) => {
      toast.success(editing ? t("editor.saved") : t("editor.added"));
      onDone(m);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <>
      <SheetHeader className="service-sheet-heading">
        <p className="sheet-eyebrow">{t("editor.eyebrow")}</p>
        <SheetTitle>{editing ? t("editor.edit") : t("editor.add")}</SheetTitle>
        <SheetDescription>{editing ? t("editor.editHint") : t("editor.addHint")}</SheetDescription>
      </SheetHeader>
      {!editing ? (
        <nav className="service-steps" aria-label={t("editor.steps")}>
          {stepTitles.map((title, index) => (
            <button
              type="button"
              key={title}
              disabled={index > step}
              aria-current={step === index ? "step" : undefined}
              onClick={() => setStep(index)}
            >
              <span>{index < step ? "✓" : `0${index + 1}`}</span>
              {title}
            </button>
          ))}
        </nav>
      ) : null}
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (stepValidation || save.isPending) return;
          if (!editing && step < 2) {
            setStep(step + 1);
            return;
          }
          save.mutate();
        }}
      >
        <SheetBody className="space-y-6" key={step}>
          {!editing ? (
            <h3 className="wizard-step-title" ref={stepHeading} tabIndex={-1}>
              {stepTitles[step]}
            </h3>
          ) : null}
          {editing || step === 0 ? (
            <>
              <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {editing ? (
                  <h3 className="text-sm font-semibold sm:col-span-2">01 · {t("editor.where")}</h3>
                ) : null}
                <div className="sm:col-span-2">
                  <TextField
                    label={t("editor.name")}
                    required
                    autoFocus={editing}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t("editor.namePh")}
                  />
                </div>
                <div className="sm:col-span-2">
                  <SelectField
                    label={t("editor.node")}
                    value={selected}
                    onValueChange={setNodeId}
                    options={usable.map((a) => ({
                      value: a.id,
                      label:
                        a.status === "online"
                          ? t("editor.nodeOnline", { name: a.name })
                          : t("editor.nodeOffline", { name: a.name }),
                    }))}
                  />
                </div>
                <SelectField
                  label={t("editor.proto")}
                  value={proto}
                  onValueChange={(v) => setProto(v as Proto)}
                  options={[
                    { value: "tcp", label: "TCP" },
                    { value: "udp", label: "UDP" },
                  ]}
                />
                <TextField
                  label={t("editor.host")}
                  value={localHost}
                  onChange={(e) => setLocalHost(e.target.value)}
                  required
                />
                <TextField
                  label={t("editor.port")}
                  type="number"
                  min={1}
                  max={65535}
                  placeholder={t("editor.portPh")}
                  value={localPort}
                  onChange={(e) => setLocalPort(e.target.value)}
                  required
                />
              </section>
            </>
          ) : null}
          {editing || step === 1 ? (
            <>
              <fieldset className="space-y-3">
                <legend className={editing ? "mb-3 text-sm font-semibold" : "sr-only"}>
                  02 · {t("editor.who")}
                </legend>
                {accessOptions().map((option) => (
                  <label
                    key={option.mode}
                    className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${mode === option.mode ? "border-pine bg-paper-2" : "border-line"}`}
                  >
                    <input
                      type="radio"
                      name="service-access"
                      className="mt-1 accent-[var(--pine)]"
                      checked={mode === option.mode}
                      onChange={() => setMode(option.mode)}
                    />
                    <span>
                      <span className="block text-sm font-medium">{option.label}</span>
                      <span className="mt-1 block text-xs leading-relaxed text-stone">
                        {option.description}
                      </span>
                    </span>
                  </label>
                ))}
                {mode !== "visitor" ? (
                  <TextField
                    label={t("editor.entry")}
                    type="number"
                    min={1}
                    max={65535}
                    value={entryPort}
                    onChange={(e) => setEntryPort(e.target.value)}
                    required
                    placeholder={t("editor.entryPh")}
                  />
                ) : null}
                <TextField
                  label={t("editor.cidr")}
                  value={allowCidrs}
                  onChange={(e) => setAllowCidrs(e.target.value)}
                  placeholder={t("editor.cidrPh")}
                />
              </fieldset>
              <details className="rounded-lg border border-line">
                <summary className="cursor-pointer p-3 text-sm font-medium">
                  {t("editor.advanced")}
                </summary>
                <div className="grid gap-4 p-3 pt-0 sm:grid-cols-2">
                  <TextField
                    label={t("editor.maxConns")}
                    inputMode="numeric"
                    value={maxConns}
                    onChange={(e) => setMaxConns(e.target.value)}
                  />
                  {mode === "spa" ? (
                    <TextField
                      label={t("editor.spaWindow")}
                      inputMode="numeric"
                      value={spaTtl}
                      onChange={(e) => setSpaTtl(e.target.value)}
                      placeholder={t("editor.spaPh")}
                    />
                  ) : null}
                  {proto === "tcp" ? (
                    <TextField
                      label={t("editor.tcpIdle")}
                      inputMode="numeric"
                      value={idleTimeout}
                      onChange={(e) => setIdleTimeout(e.target.value)}
                      placeholder={t("editor.tcpIdlePh")}
                    />
                  ) : (
                    <TextField
                      label={t("editor.udpIdle")}
                      inputMode="numeric"
                      value={udpIdle}
                      onChange={(e) => setUdpIdle(e.target.value)}
                      placeholder={t("editor.udpIdlePh")}
                    />
                  )}
                  <RateLimitField value={rateKbps} onChange={setRateKbps} />
                </div>
              </details>
            </>
          ) : null}
          {editing || step === 2 ? (
            <>
              <section className="rounded-lg bg-paper-2 p-5 text-sm leading-relaxed">
                <h3 className="text-xl font-semibold">{name || t("editor.untitled")}</h3>
                <p className="mt-2 text-xs text-stone">
                  {accessOptions().find((option) => option.mode === mode)?.label}
                  {mode !== "visitor"
                    ? t("editor.entryPort", { port: entryPort })
                    : t("editor.noPublic")}
                </p>
                <p className="mt-1 break-all text-ink-soft">
                  {usable.find((node) => node.id === selected)?.name ?? t("editor.pickNode")} →{" "}
                  {localHost || t("editor.hostPh")}:{localPort || t("editor.portWord")} ·{" "}
                  {proto.toUpperCase()}
                </p>
                <p className="mt-1 text-xs text-stone">
                  {mode === "visitor"
                    ? t("editor.visitorNext")
                    : mode === "spa"
                      ? t("editor.spaNext")
                      : t("editor.publicNext")}
                </p>
                {usable.find((node) => node.id === selected)?.status !== "online" ? (
                  <p className="mt-2 text-xs text-amber">{t("editor.nodeOfflineHint")}</p>
                ) : null}
                {save.error ? (
                  <p role="alert" className="mt-2 text-rose">
                    {save.error.message}
                  </p>
                ) : null}
              </section>
              <p className="text-xs text-stone">
                {t("editor.cidrLine", {
                  cidr: allowCidrs || t("editor.noCidr"),
                  max: maxConns,
                })}
                {Number(rateKbps) ? t("editor.rateLine", { n: rateKbps }) : t("editor.noRate")}.
              </p>
            </>
          ) : null}
        </SheetBody>
        <SheetFooter className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-stone" aria-live="polite">
            {stepValidation ?? (!editing && step < 2 ? t("editor.nextHint") : t("editor.saveHint"))}
          </p>
          <div className="flex shrink-0 gap-2">
            <SheetClose asChild>
              <Button type="button" variant="ghost">
                {t("common.cancel")}
              </Button>
            </SheetClose>
            {!editing && step > 0 ? (
              <Button type="button" variant="outline" onClick={() => setStep(step - 1)}>
                {t("editor.back")}
              </Button>
            ) : null}
            <Button type="submit" disabled={Boolean(stepValidation) || save.isPending}>
              {save.isPending
                ? editing
                  ? t("common.saving")
                  : t("editor.pushing")
                : editing
                  ? t("editor.save")
                  : step < 2
                    ? t("editor.next")
                    : t("editor.confirmConnect")}
            </Button>
          </div>
        </SheetFooter>
      </form>
    </>
  );
}
