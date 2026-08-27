"use client";

import type { ComponentProps, ReactNode, TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
    </label>
  );
}

export function TextField({
  label,
  ...props
}: { label: string } & ComponentProps<typeof Input>) {
  return (
    <Field label={label}>
      <Input {...props} />
    </Field>
  );
}

export function SelectField({
  label,
  value,
  onValueChange,
  options,
  placeholder,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onValueChange} options={options} placeholder={placeholder} />
    </div>
  );
}

export function TextAreaField({
  label,
  className,
  ...props
}: { label: string } & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <Field label={label}>
      <textarea
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
