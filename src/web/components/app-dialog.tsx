import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const SIZES = {
  md: "sm:max-w-xl",
  lg: "sm:max-w-4xl",
  xl: "sm:max-w-6xl",
} as const;

/**
 * Modal shell: always open, the parent mounts and unmounts it. Escape, outside click and the close button call `onClose`,
 * so "unsaved changes" guards live in the parent's `onClose`. The body scrolls; header and footer stay put.
 */
export function AppDialog({
  title,
  description,
  footer,
  size,
  onClose,
  onEscapeKeyDown,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  size: keyof typeof SIZES;
  onClose: () => void;
  /** Called before Escape dismisses the dialog; `preventDefault()` keeps it open (e.g. while a drag is in progress). */
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  children: ReactNode;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent onEscapeKeyDown={onEscapeKeyDown} className={cn("flex max-h-[calc(100dvh-4rem)] flex-col gap-0 p-0", SIZES[size])}>
        <DialogHeader className="border-b px-4 py-3 pr-11">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className={description ? undefined : "sr-only"}>{description ?? title}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
        {footer && <DialogFooter className="border-t px-4 py-3">{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}
