import type * as React from "react";
import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-[30px] w-full min-w-0 rounded-md border border-input bg-card px-2.5 text-[13px] transition-colors duration-150 outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-45 aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
