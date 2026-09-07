import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const { t } = useI18n();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast.success(t("common.copied"));
        } catch {
          toast.error(t("common.copyFailed"));
        }
      }}
    >
      <Copy className="mr-1.5 size-3.5" />
      {label ?? t("common.copy")}
    </Button>
  );
}
