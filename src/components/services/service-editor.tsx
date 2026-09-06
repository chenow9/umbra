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
      <Label htmlFor={id}>限速</Label>
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
          aria-label="限速单位"
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
    ? "请选择有效的节点。"
    : validateService(payload);

  const targetValidation = !usable.some((node) => node.id === selected)
    ? "请选择有效的节点。"
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
  const stepTitles = ["服务在哪里", "谁可以访问", "确认并接入"];

  const save = useMutation({
    mutationFn: () =>
      editing
        ? updateMapping({ data: { id: mapping.id, ...payload } })
        : createMapping({ data: payload }),
    onSuccess: (m) => {
      toast.success(editing ? "服务配置已保存" : "服务已添加，接下来查看连接方式");
      onDone(m);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <>
      <SheetHeader className="service-sheet-heading">
        <p className="sheet-eyebrow">SERVICE / 服务配置</p>
        <SheetTitle>{editing ? "编辑服务" : "添加服务"}</SheetTitle>
        <SheetDescription>
          {editing
            ? "配置会动态下发；修改访问方式会改变连接方法。"
            : "告诉 Umbra 服务在哪里，以及谁可以访问。"}
        </SheetDescription>
      </SheetHeader>
      {!editing ? (
        <nav className="service-steps" aria-label="添加服务步骤">
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
                  <h3 className="text-sm font-semibold sm:col-span-2">01 · 服务在哪里</h3>
                ) : null}
                <div className="sm:col-span-2">
                  <TextField
                    label="服务名称"
                    required
                    autoFocus={editing}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="例如：工作电脑 SSH"
                  />
                </div>
                <div className="sm:col-span-2">
                  <SelectField
                    label="节点"
                    value={selected}
                    onValueChange={setNodeId}
                    options={usable.map((a) => ({
                      value: a.id,
                      label: `${a.name} · ${a.status === "online" ? "在线" : "离线"}`,
                    }))}
                  />
                </div>
                <SelectField
                  label="协议"
                  value={proto}
                  onValueChange={(v) => setProto(v as Proto)}
                  options={[
                    { value: "tcp", label: "TCP" },
                    { value: "udp", label: "UDP" },
                  ]}
                />
                <TextField
                  label="目标地址"
                  value={localHost}
                  onChange={(e) => setLocalHost(e.target.value)}
                  required
                />
                <TextField
                  label="目标端口"
                  type="number"
                  min={1}
                  max={65535}
                  placeholder="例如：22"
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
                  02 · 谁可以访问
                </legend>
                {accessOptions.map((option) => (
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
                    label="公网入口端口"
                    type="number"
                    min={1}
                    max={65535}
                    value={entryPort}
                    onChange={(e) => setEntryPort(e.target.value)}
                    required
                    placeholder="例如：22022"
                  />
                ) : null}
                <TextField
                  label="允许的来源网段（可选）"
                  value={allowCidrs}
                  onChange={(e) => setAllowCidrs(e.target.value)}
                  placeholder="例如：10.0.0.0/8，留空不限制来源 IP"
                />
              </fieldset>
              <details className="rounded-lg border border-line">
                <summary className="cursor-pointer p-3 text-sm font-medium">
                  高级设置 · 连接数、超时与限速
                </summary>
                <div className="grid gap-4 p-3 pt-0 sm:grid-cols-2">
                  <TextField
                    label="最大连接"
                    inputMode="numeric"
                    value={maxConns}
                    onChange={(e) => setMaxConns(e.target.value)}
                  />
                  {mode === "spa" ? (
                    <TextField
                      label="敲门窗口"
                      inputMode="numeric"
                      value={spaTtl}
                      onChange={(e) => setSpaTtl(e.target.value)}
                      placeholder="秒，只限制新建"
                    />
                  ) : null}
                  {proto === "tcp" ? (
                    <TextField
                      label="TCP 空闲"
                      inputMode="numeric"
                      value={idleTimeout}
                      onChange={(e) => setIdleTimeout(e.target.value)}
                      placeholder="秒，0 不断开"
                    />
                  ) : (
                    <TextField
                      label="UDP 空闲"
                      inputMode="numeric"
                      value={udpIdle}
                      onChange={(e) => setUdpIdle(e.target.value)}
                      placeholder="秒，无报文后回收"
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
                <h3 className="text-xl font-semibold">{name || "服务配置"}</h3>
                <p className="mt-2 text-xs text-stone">
                  {accessOptions.find((option) => option.mode === mode)?.label}
                  {mode !== "visitor" ? ` · 入口端口 ${entryPort}` : " · 不占用公网业务端口"}
                </p>
                <p className="mt-1 break-all text-ink-soft">
                  {usable.find((node) => node.id === selected)?.name ?? "选择节点"} →{" "}
                  {localHost || "目标地址"}:{localPort || "目标端口"} · {proto.toUpperCase()}
                </p>
                <p className="mt-1 text-xs text-stone">
                  {mode === "visitor"
                    ? "入口不开放业务端口。添加后签发访问命令，在访问方电脑运行。"
                    : mode === "spa"
                      ? "入口监听业务端口，访问前需临时放行来源 IP。"
                      : "入口会监听公网业务端口。请确认目标服务自身具备所需的身份验证。"}
                </p>
                {usable.find((node) => node.id === selected)?.status !== "online" ? (
                  <p className="mt-2 text-xs text-amber">节点尚未在线，配置会在重连后下发。</p>
                ) : null}
                {save.error ? (
                  <p role="alert" className="mt-2 text-rose">
                    {save.error.message}
                  </p>
                ) : null}
              </section>
              <p className="text-xs text-stone">
                来源限制：{allowCidrs || "未设置 CIDR 白名单"}。最大连接 {maxConns}，
                {Number(rateKbps) ? `限速 ${rateKbps} KB/s` : "不限速"}。
              </p>
            </>
          ) : null}
        </SheetBody>
        <SheetFooter className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-stone" aria-live="polite">
            {stepValidation ??
              (!editing && step < 2 ? "下一步前可随时返回修改。" : "保存后进入连接与诊断。")}
          </p>
          <div className="flex shrink-0 gap-2">
            <SheetClose asChild>
              <Button type="button" variant="ghost">
                取消
              </Button>
            </SheetClose>
            {!editing && step > 0 ? (
              <Button type="button" variant="outline" onClick={() => setStep(step - 1)}>
                上一步
              </Button>
            ) : null}
            <Button type="submit" disabled={Boolean(stepValidation) || save.isPending}>
              {save.isPending
                ? editing
                  ? "保存中…"
                  : "下发中…"
                : editing
                  ? "保存配置"
                  : step < 2
                    ? "下一步"
                    : "确认接入并连接"}
            </Button>
          </div>
        </SheetFooter>
      </form>
    </>
  );
}
