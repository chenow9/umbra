"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

export function SheetContent({
  className,
  children,
  side = "left",
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & { side?: "left" | "right" }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-ink/30 pointer-events-auto" />
      <DialogPrimitive.Content
        className={cn(
          "fixed inset-y-0 z-50 flex flex-col shadow-border pointer-events-auto",
          side === "left"
            ? "left-0 w-72 bg-paper-2 p-4"
            : "right-0 w-full max-w-md overflow-hidden bg-paper p-5 sm:p-6",
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="absolute top-2 right-2 inline-flex size-10 items-center justify-center rounded-md text-stone hover:bg-paper-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pine/40">
          <X className="size-4" />
          <span className="sr-only">关闭</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function SheetHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("mb-5 space-y-1 pr-6", className)} {...props} />;
}

export function SheetTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title className={cn("text-base font-medium text-ink", className)} {...props} />
  );
}

export function SheetDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn("text-sm leading-relaxed text-stone", className)}
      {...props}
    />
  );
}

export function SheetBody({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("-mx-5 min-h-0 flex-1 overflow-y-auto px-5 pb-4 sm:-mx-6 sm:px-6", className)}
      {...props}
    />
  );
}

export function SheetFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "-mx-5 mt-1 shrink-0 border-t border-line bg-paper px-5 pt-4 sm:-mx-6 sm:px-6",
        className,
      )}
      {...props}
    />
  );
}
