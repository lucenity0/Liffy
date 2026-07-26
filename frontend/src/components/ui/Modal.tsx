import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./Button";

/**
 * Built on the native <dialog>, which gives the focus trap, the top-layer
 * stacking, inert background content and Esc-to-close for free — all things
 * a hand-rolled modal gets subtly wrong.
 *
 * Two native quirks are handled here: Esc fires `cancel`, not `close`, and a
 * backdrop click lands on the <dialog> element itself rather than a child.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    // Esc dispatches `cancel`; preventDefault so React state stays the
    // single source of truth for whether the dialog is open.
    const onCancel = (event: Event) => {
      event.preventDefault();
      onClose();
    };
    dialog.addEventListener("cancel", onCancel);
    return () => dialog.removeEventListener("cancel", onCancel);
  }, [onClose]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="modal-title"
      // A click on the backdrop targets the <dialog> itself, never a child.
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className={cn(
        "rounded-sheet m-auto w-[min(30rem,calc(100vw-2rem))] border border-rule-strong bg-card p-0",
        "text-ink shadow-hard-lg backdrop:bg-ink/25",
        className,
      )}
    >
      <div className="flex items-start gap-3 border-b border-rule bg-recessed px-4 py-3">
        <div className="flex flex-col gap-0.5">
          <h2 id="modal-title" className="font-hand text-lg leading-tight text-ink">
            {title}
          </h2>
          {description && (
            <p className="text-sm text-ink-dim">{description}</p>
          )}
        </div>
        <Button
          variant="ghost"
          onClick={onClose}
          aria-label="Close"
          className="ml-auto px-1.5"
        >
          ✕
        </Button>
      </div>

      <div className="px-4 py-4">{children}</div>

      {footer && (
        <div className="flex items-center justify-end gap-2 border-t border-rule bg-recessed px-4 py-3">
          {footer}
        </div>
      )}
    </dialog>
  );
}
