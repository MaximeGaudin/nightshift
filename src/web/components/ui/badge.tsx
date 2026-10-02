import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-full border px-2 py-px font-sans text-[11px] leading-4 font-medium whitespace-nowrap transition-colors duration-150 [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary/12 text-primary",
        secondary: "border-transparent bg-secondary text-muted-foreground",
        outline: "border-border text-foreground",
        ok: "border-transparent bg-ok-soft text-ok",
        warn: "border-transparent bg-warn-soft text-warn",
        destructive: "border-transparent bg-err-soft text-err",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

/** Color of the leading dot of a pill. */
const DOT_COLORS = {
  primary: "bg-primary",
  ok: "bg-ok",
  warn: "bg-warn",
  err: "bg-err",
  muted: "bg-muted-foreground/60",
} as const;

export type BadgeDot = keyof typeof DOT_COLORS;

function Badge({
  className,
  variant,
  dot,
  asChild = false,
  children,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean; dot?: BadgeDot }) {
  const Comp = asChild ? Slot : "span";
  return (
    <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot && !asChild && (
        <span data-slot="badge-dot" aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", DOT_COLORS[dot])} />
      )}
      {children}
    </Comp>
  );
}

export { Badge, badgeVariants };
