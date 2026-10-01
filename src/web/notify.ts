import { toast } from "sonner";

/** Transient error shown as a toast (the Toaster is mounted by the app shell). */
export function notifyError(message: string) {
  toast.error(message);
}
