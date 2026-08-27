import type { ComponentProps, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
  className,
  children,
  ...props
}: { label: string } & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <Field label={label}>
      <select
        className={cn(
          "flex h-11 w-full rounded-md bg-paper px-3 text-sm text-ink shadow-border",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pine/35",
          className,
        )}
        {...props}
      >
        {children}
      </select>
    </Field>
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
