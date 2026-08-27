import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[background-color,box-shadow] duration-100 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pine/40 disabled:cursor-wait disabled:opacity-80",
  {
    variants: {
      variant: {
        default: "bg-pine text-pine-fg hover:bg-moss",
        secondary: "bg-paper-2 text-ink hover:bg-line",
        outline: "bg-transparent text-ink shadow-border hover:bg-paper-2",
        ghost: "text-ink-soft hover:bg-paper-2 hover:text-ink",
        destructive: "bg-rose text-pine-fg hover:opacity-90",
        link: "text-pine underline-offset-4 hover:underline",
      },
      size: {
        default: "h-11 px-4",
        sm: "h-8 rounded-sm px-3 text-xs",
        lg: "h-11 px-5",
        icon: "size-10",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}
