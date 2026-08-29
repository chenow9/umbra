"use client";

import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { NameDotHint } from "@/components/mode-name";
import { cn } from "@/lib/utils";

export function Select({
  value,
  onValueChange,
  options,
  placeholder = "选择",
  disabled,
  id,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: { value: string; label: string; hint?: string }[];
  placeholder?: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <SelectPrimitive.Root
      value={value || undefined}
      onValueChange={onValueChange}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger
        id={id}
        className={cn(
          "flex h-11 w-full min-w-0 items-center justify-between gap-2 rounded-md bg-paper px-3 text-left text-sm text-ink shadow-border",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pine/35",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "data-[placeholder]:text-stone",
        )}
      >
        <span className="min-w-0 flex-1 truncate">
          <SelectPrimitive.Value placeholder={placeholder} />
        </span>
        <SelectPrimitive.Icon asChild>
          <ChevronDown className="size-4 shrink-0 text-stone" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className={cn(
            "z-[80] max-h-72 overflow-hidden rounded-md bg-card text-ink shadow-border",
            "min-w-[var(--radix-select-trigger-width)] w-max max-w-[min(20rem,calc(100vw-2rem))]",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
          )}
        >
          <SelectPrimitive.Viewport className="p-1">
            {options.map((o) => (
              <SelectPrimitive.Item
                key={o.value}
                value={o.value}
                className={cn(
                  "relative flex min-h-9 cursor-pointer select-none items-center rounded-sm py-1.5 pr-8 pl-3 text-sm outline-none",
                  "whitespace-nowrap",
                  "data-[highlighted]:bg-paper-2 data-[highlighted]:text-ink",
                  "data-[state=checked]:text-ink",
                )}
              >
                <SelectPrimitive.ItemText>
                  {o.hint ? <NameDotHint name={o.label} hint={o.hint} /> : o.label}
                </SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="absolute right-2 inline-flex">
                  <Check className="size-3.5 text-moss" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
