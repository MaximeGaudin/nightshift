import type * as React from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type IconButtonProps = Omit<React.ComponentProps<typeof Button>, "aria-label" | "size" | "asChild"> & { label: string };

/** The only way to render an icon-only button: ghost icon Button whose tooltip and aria-label are the same label. */
export function IconButton({ label, children, variant = "ghost", type = "button", ...props }: IconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type={type} variant={variant} size="icon" aria-label={label} {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
