import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Dropdown, type DropdownOption } from "@/components/ui/Dropdown";
import { Input } from "@/components/ui/Field";
import { StatusBadge } from "@/components/ui/badgeMaps";
import { useRepos } from "@/hooks/useRepos";
import { isValidPrNumber } from "@/lib/validators";
import { isNonDefaultView, type ReviewFilters } from "@/lib/pagination";
import { cn } from "@/lib/utils";
import { REVIEW_STATUSES } from "@/types/api";

/**
 * The controls above the reviews list — one strip, folded away behind the
 * funnel in the list's header until someone asks for it.
 *
 * Four labelled boxes on their own line were four labels' worth of chrome
 * standing permanently above a list most people never filter, and they
 * wrapped to two rows on a narrow window. So: the labels move *into* the
 * controls (the button says "Repository" until it says which repository), the
 * PR box lives behind a magnifier, order drops from a whole dropdown to one
 * icon, and the strip only exists once the funnel is on.
 *
 * Everything in the row is `h-8` from `CONTROL` — a strip of mixed heights is
 * what made the old one read as floating rather than as part of the sheet.
 *
 * Stateless about filters: every one is owned by the URL and handed down, so
 * the parent stays the single place that knows how to change one — which is
 * also where the offset reset lives.
 *
 * That includes the PR number box, whose draft is the parent's too. It is the
 * one control whose displayed value can differ from the filter — it renders
 * every keystroke while only filtering once typing settles — and reconciling
 * those two has to happen wherever the URL is written, not here. See
 * `Reviews`.
 */

/** The id `FilterToggle` points `aria-controls` at. One list per page. */
export const FILTER_PANEL_ID = "review-filters";

/** One height, one border, one fill — for every control in the strip. */
const CONTROL = "h-8 shrink-0";

/** An icon-only control that still matches the boxes beside it. */
const ICON_CONTROL = cn(
  CONTROL,
  "w-8 justify-center px-0 border-rule bg-paper text-ink-dim",
  "hover:border-rule-strong hover:text-ink",
);

export function ReviewFilterBar({
  filters,
  prDraft,
  onPrDraftChange,
  onChange,
  onClear,
}: {
  filters: ReviewFilters;
  prDraft: string;
  onPrDraftChange: (next: string) => void;
  onChange: (next: Partial<ReviewFilters>) => void;
  onClear: () => void;
}) {
  const repos = useRepos();
  const invalidPr = prDraft.trim() !== "" && !isValidPrNumber(prDraft.trim());

  const repoOptions: DropdownOption[] = [
    // Maps to *no* parameter, not to an empty one.
    { value: "", label: "All repositories", triggerLabel: "Repository" },
    ...(repos.data ?? []).map((repo) => ({
      value: repo.id,
      label: repo.full_name,
    })),
  ];

  // The badges the rows themselves are marked with, rather than a second set
  // of words for the same four states — that mismatch ("Queued" here against
  // "Pending" on every row) was the filter's own invention.
  const statusOptions: DropdownOption[] = [
    { value: "", label: "All statuses", triggerLabel: "All" },
    ...REVIEW_STATUSES.map((status) => ({
      value: status,
      label: status.charAt(0).toUpperCase() + status.slice(1),
      node: <StatusBadge value={status} />,
    })),
  ];

  const newest = filters.sort === "newest";

  return (
    <div
      id={FILTER_PANEL_ID}
      // `bg-recessed`, the sheet header's own fill, and no rule between the
      // two: the strip is the header carrying on downwards rather than a
      // second bar sitting under it. Only the bottom edge is drawn, which is
      // where the header block genuinely ends and the rows begin.
      //
      // No padding of its own on top — the header's own `min-h-11` already
      // leaves ~14px under the title, and adding to it left the controls
      // sitting low in the block with the rule tight under them. `pb-4` then
      // matches `px-4`, so the row is inset by the same 16px on the three
      // sides the strip actually owns and reads as centred between the title
      // and the rule.
      className="flex flex-wrap items-center gap-2 border-b border-rule bg-recessed px-4 pt-0 pb-4"
    >
      <PrSearch
        draft={prDraft}
        invalid={invalidPr}
        onDraftChange={onPrDraftChange}
      />

      <Dropdown
        label="Repository"
        value={filters.repoId ?? ""}
        options={repoOptions}
        onChange={(next) => onChange({ repoId: next || undefined })}
        className="w-44"
      />

      <Dropdown
        label="Status"
        value={filters.status ?? ""}
        options={statusOptions}
        onChange={(next) =>
          onChange({ status: (next || undefined) as ReviewFilters["status"] })
        }
        className="w-32"
      />

      {/* Order is one bit, so it is one button rather than a dropdown holding
          two rows. The name states the current order and the title says what
          clicking does, because a toggle that renames itself mid-press is
          impossible to follow by keyboard. */}
      <Button
        variant="ghost"
        onClick={() => onChange({ sort: newest ? "oldest" : "newest" })}
        aria-label={newest ? "Sort: newest first" : "Sort: oldest first"}
        title={newest ? "Show oldest first" : "Show newest first"}
        className={ICON_CONTROL}
      >
        <SortIcon newest={newest} />
      </Button>

      {/* Only rendered when there is something to clear — which includes a
          non-default order, because clearing resets that too. Filters persist
          in the URL, which makes them easy to forget about a day later and
          then read as "Liffy lost my reviews" — this is the way back. */}
      {isNonDefaultView(filters) && (
        <Button variant="ghost" onClick={onClear} className={cn(CONTROL, "ml-auto")}>
          Clear filters
        </Button>
      )}
    </div>
  );
}

/**
 * The PR number box, folded into its own magnifier.
 *
 * Open whenever there is something in it, not only when the button was
 * pressed: a filter you cannot see is a filter you cannot undo, and `?pr=203`
 * arrives from a pasted link with the box already full.
 *
 * Closing empties it, which is the only honest reading of dismissing a search
 * — leaving `pr=203` applied under a collapsed magnifier would hide rows with
 * nothing on screen saying why.
 */
function PrSearch({
  draft,
  invalid,
  onDraftChange,
}: {
  draft: string;
  invalid: boolean;
  onDraftChange: (next: string) => void;
}) {
  const [pressed, setPressed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const open = pressed || draft !== "";

  useEffect(() => {
    if (pressed) inputRef.current?.focus();
  }, [pressed]);

  function close() {
    setPressed(false);
    onDraftChange("");
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="ghost"
        onClick={() => (open ? close() : setPressed(true))}
        aria-expanded={open}
        aria-label="Search by PR number"
        title={open ? "Clear the PR number" : "Search by PR number"}
        className={cn(ICON_CONTROL, open && "border-rule-strong text-ink")}
      >
        <SearchIcon />
      </Button>

      {open && (
        <>
          <Input
            ref={inputRef}
            aria-label="PR number"
            aria-invalid={invalid ? true : undefined}
            inputMode="numeric"
            placeholder="PR #"
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              // Escape out of a search box empties it, the way Escape in the
              // browser's own find bar does.
              event.preventDefault();
              close();
            }}
            // Deliberately not collapsing on blur: the magnifier is what
            // closes this, and mousedown on it blurs the box first — so a
            // blur handler would collapse and the click would reopen, leaving
            // the one button that closes the search unable to.
            className={cn(CONTROL, "w-24")}
          />
          {invalid && <span className="text-sm text-oxide">Digits only.</span>}
        </>
      )}
    </div>
  );
}

/**
 * The funnel that reveals the strip, for the reviews list's header.
 *
 * Lives here rather than in `Reviews` so the icon and the panel it opens stay
 * in one file, and carries a dot whenever the view is not the default one — a
 * folded-away strip must not be able to hide a filter that is still applied.
 */
export function FilterToggle({
  open,
  active,
  onToggle,
}: {
  open: boolean;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      variant="ghost"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={open ? FILTER_PANEL_ID : undefined}
      aria-label="Filters"
      title={open ? "Hide filters" : "Show filters"}
      className={cn("relative px-1.5", open && "border-rule text-ink")}
    >
      <FunnelIcon />
      {active && (
        <span
          aria-hidden="true"
          className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-oxide"
        />
      )}
    </Button>
  );
}

const ICON_PROPS = {
  "aria-hidden": true,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.25,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function SearchIcon() {
  return (
    <svg {...ICON_PROPS} className="size-4">
      <circle cx="7" cy="7" r="4.25" />
      <path d="M10.25 10.25 14 14" />
    </svg>
  );
}

function FunnelIcon() {
  return (
    <svg {...ICON_PROPS} className="size-4">
      <path d="M2.5 3.25h11L9.25 8.25v4.25l-2.5 1.25V8.25z" />
    </svg>
  );
}

/** Both arrows, with the direction actually in force at full ink. */
function SortIcon({ newest }: { newest: boolean }) {
  return (
    <svg {...ICON_PROPS} className="size-4">
      <g opacity={newest ? 0.35 : 1}>
        <path d="M4.5 13V3.5" />
        <path d="M2 6 4.5 3.5 7 6" />
      </g>
      <g opacity={newest ? 1 : 0.35}>
        <path d="M11.5 3v9.5" />
        <path d="M9 10l2.5 2.5L14 10" />
      </g>
    </svg>
  );
}
