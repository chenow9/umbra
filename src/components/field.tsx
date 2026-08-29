"use client";

import { useId, type ComponentProps, type ReactNode, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

export function Field({ label, children, id }: { label: string; children: ReactNode; id: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

export function TextField({ label, ...props }: { label: string } & ComponentProps<typeof Input>) {
  const generatedId = useId();
  const id = props.id ?? generatedId;
  return (
    <Field label={label} id={id}>
      <Input {...props} id={id} />
    </Field>
  );
}

export function SelectField({
  label,
  value,
  onValueChange,
  options,
  placeholder,
  className,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: { value: string; label: string; hint?: string }[];
  placeholder?: string;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      <Select
        id={id}
        value={value}
        onValueChange={onValueChange}
        options={options}
        placeholder={placeholder}
      />
    </div>
  );
}

export function CheckField({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-2.5 text-sm text-ink">
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 size-4 accent-[var(--pine)]"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="font-medium">{label}</span>
        {hint ? <span className="mt-0.5 block text-xs text-stone">{hint}</span> : null}
      </span>
    </label>
  );
}

export function TextAreaField({
  label,
  className,
  ...props
}: { label: string } & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const generatedId = useId();
  const id = props.id ?? generatedId;
  return (
    <Field label={label} id={id}>
      <textarea
        id={id}
        className={cn(
          "min-h-20 w-full rounded-md bg-paper px-3 py-2 text-sm text-ink shadow-border",
          "placeholder:text-stone focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pine/35",
          className,
        )}
        {...props}
      />
    </Field>
  );
}
