"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "确认",
  pending,
  danger,
  onConfirm,
  onOpenChange,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  pending?: boolean;
  danger?: boolean;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            取消
          </Button>
          <Button
            type="button"
            variant={danger ? "destructive" : "default"}
            disabled={pending}
            onClick={onConfirm}
          >
            {pending ? "处理中…" : confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
