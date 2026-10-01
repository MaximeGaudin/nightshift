import type * as React from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type IconButtonProps = Omit<React.ComponentProps<typeof Button>, "aria-label" | "size" | "asChild"> & { label: string };

/**
 * The only way to render an icon-only button: ghost icon Button whose tooltip and aria-label are the same label.
 * A disabled button gets no pointer or focus events, so it is wrapped in a focusable span that triggers the tooltip
 * (often the reason it is disabled).
 */
export function IconButton({ label, children, variant = "ghost", type = "button", ...props }: IconButtonProps) {
  const button = (
    <Button type={type} variant={variant} size="icon" aria-label={label} {...props}>
      {children}
    </Button>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {props.disabled ? (
          // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users must reach the tooltip of a disabled button.
          <span className="inline-flex rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring" tabIndex={0}>
            {button}
          </span>
        ) : (
          button
        )}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
