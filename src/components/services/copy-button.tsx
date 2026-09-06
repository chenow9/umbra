import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export function CopyButton({ text, label = "复制" }: { text: string; label?: string }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast.success("已复制");
        } catch {
          toast.error("复制失败，请选中文本手动复制。");
        }
      }}
    >
      <Copy className="mr-1.5 size-3.5" />
      {label}
    </Button>
  );
}
