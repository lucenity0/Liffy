import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

/**
 * A select whose options can be *drawn* rather than spelled.
 *
 * `Field`'s native `<select>` is still the right control almost everywhere,
 * and this does not replace it — a native one is keyboard reachable, labelled
 * and correct on touch for free. The one thing it cannot do is put a Badge in
 * the list: `<option>` renders text and nothing else, so the reviews filter
 * had to spell "Failed" as plain words next to rows that show it as a badge.
 *
 * So this implements ARIA's select-only combobox: a button that owns the
 * value, a listbox that appears under it, focus staying on the button while
 * `aria-activedescendant` moves through the rows. Written out rather than
 * pulled in because it is the app's only rich dropdown, and the keyboard
 * contract below is the part hand-rolled ones get wrong.
 *
 *   ↓ / ↑ / Enter / Space   open, starting on the current value
 *   ↓ / ↑                   move the active row (no wrap — the ends are felt)
 *   Home / End              first / last row
 *   Enter / Space           take the active row and close
 *   Esc                     close, value untouched
 *   Tab                     close and move on, value untouched
 *
 * Escape and Tab both leave the value alone: this commits on choice, not on
 * traversal, so arrowing past an option is never the same as picking it.
 */

export interface DropdownOption {
  value: string;
  /** Spoken name of the row, and its text when `node` is absent. */
  label: string;
  /** Rich content for the row — a Badge, say. */
  node?: ReactNode;
  /**
   * What the closed button shows for this option, when the row's own wording
   * is too long for it. "All repositories" reads well in a list; the button
   * it sits above only has room to say which field it is.
   */
  triggerLabel?: ReactNode;
}

export function Dropdown({
  label,
  value,
  options,
  onChange,
  className,
  listClassName,
}: {
  /** The field's name — what the button is called, since it has no visible label. */
  label: string;
  value: string;
  options: DropdownOption[];
  onChange: (next: string) => void;
  className?: string;
  listClassName?: string;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const optionId = (index: number) => `${id}-option-${index}`;

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // A value with no matching option (a repo that has since been disconnected,
  // say) falls back to the first row rather than rendering an empty button.
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const selected = options[selectedIndex];

  useEffect(() => {
    if (!open) return;

    // Pointer, not click: a mousedown outside dismisses immediately rather
    // than waiting for a button-up that may land somewhere else entirely.
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Arrowing to a row below the fold has to bring it into view — the active
  // row is the only thing telling a keyboard user where they are.
  useEffect(() => {
    if (!open) return;
    const row = listRef.current?.querySelector('[data-active="true"]');
    row?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);

  function openList() {
    setActive(selectedIndex);
    setOpen(true);
  }

  function commit(index: number) {
    const option = options[index];
    if (option) onChange(option.value);
    setOpen(false);
    // Back to the button, not to the top of the document — otherwise choosing
    // an option silently loses the user's place in the tab order.
    triggerRef.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (open) setActive((index) => Math.min(options.length - 1, index + 1));
        else openList();
        break;
      case "ArrowUp":
        event.preventDefault();
        if (open) setActive((index) => Math.max(0, index - 1));
        else openList();
        break;
      case "Home":
        if (!open) break;
        event.preventDefault();
        setActive(0);
        break;
      case "End":
        if (!open) break;
        event.preventDefault();
        setActive(options.length - 1);
        break;
      case "Enter":
      case " ":
        // Prevented either way: on a button both keys would otherwise fire a
        // click straight after this and toggle the list back.
        event.preventDefault();
        if (open) commit(active);
        else openList();
        break;
      case "Escape":
        if (!open) break;
        event.preventDefault();
        setOpen(false);
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  }

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? optionId(active) : undefined}
        // The button shows the value; the field's name is only in here, so
        // both have to be spoken. Reads as "Status: Failed".
        aria-label={`${label}: ${selected?.label ?? ""}`}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
        className={cn(
          "rounded-chip flex h-8 w-full items-center gap-2 border border-rule bg-paper px-2.5",
          "text-base text-ink hover:border-rule-strong",
        )}
      >
        <span className="min-w-0 truncate">
          {selected?.triggerLabel ?? selected?.node ?? selected?.label}
        </span>
        <Chevron open={open} />
      </button>

      {open && (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={label}
          // In flow rather than in a portal, so it is clipped by any scroll
          // container it sits inside — `Sheet` is `overflow-hidden`. `max-h-56`
          // is what keeps a long list (every connected repo) inside even the
          // shortest sheet this opens in, which is one showing an empty state.
          className={cn(
            "rounded-sheet absolute left-0 z-30 mt-1 max-h-56 min-w-full overflow-y-auto",
            "border border-rule-strong bg-card py-1 shadow-hard-lg",
            listClassName,
          )}
        >
          {options.map((option, index) => (
            <div
              key={option.value}
              id={optionId(index)}
              role="option"
              aria-selected={option.value === value}
              data-active={index === active || undefined}
              // Focus never leaves the button, so the list is never the reason
              // it blurs — without this the mousedown would steal it and the
              // outside-pointer handler would close before the click landed.
              onPointerDown={(event) => event.preventDefault()}
              onMouseMove={() => setActive(index)}
              onClick={() => commit(index)}
              className={cn(
                "flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-base whitespace-nowrap text-ink",
                index === active && "bg-recessed",
              )}
            >
              <span className="min-w-0 truncate">{option.node ?? option.label}</span>
              {option.value === value && <Tick />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Inline SVG on currentColor, so it inherits the trigger's ink like a glyph. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={cn(
        "ml-auto size-3.5 shrink-0 text-ink-sub transition-transform duration-100",
        open && "-scale-y-100",
      )}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 6.5 8 10.5 12 6.5" />
    </svg>
  );
}

/** The chosen row, marked for eyes as well as for `aria-selected`. */
function Tick() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="ml-auto size-3.5 shrink-0 text-ink-dim"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
    </svg>
  );
}
