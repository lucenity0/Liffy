import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useRepos } from "@/hooks/useRepos";
import { isValidPrNumber } from "@/lib/validators";
import { hasActiveFilters, type ReviewFilters } from "@/lib/pagination";
import { REVIEW_STATUSES, type ReviewStatus } from "@/types/api";

/** Sentence case, because these are labels rather than the raw column values. */
const STATUS_LABELS: Record<ReviewStatus, string> = {
  pending: "Queued",
  processing: "Running",
  completed: "Completed",
  failed: "Failed",
};

/**
 * The controls above the reviews list.
 *
 * Stateless apart from the PR number box: every filter is owned by the URL and
 * handed down, so the parent stays the single place that knows how to change
 * one — which is also where the offset reset lives.
 */
export function ReviewFilterBar({
  filters,
  onChange,
  onClear,
}: {
  filters: ReviewFilters;
  onChange: (next: Partial<ReviewFilters>) => void;
  onClear: () => void;
}) {
  const repos = useRepos();

  /**
   * The one control with local state. It is a free-text box, so it has to
   * render every keystroke while only *filtering* once typing settles —
   * otherwise "203" asks the API about PR 2 and PR 20 on the way.
   */
  const asText = (value: number | undefined) =>
    value === undefined ? "" : String(value);

  const [prDraft, setPrDraft] = useState(() => asText(filters.prNumber));
  const settledPr = useDebouncedValue(prDraft.trim());

  /**
   * Re-seed the box when the filter changes underneath it — Clear filters,
   * or a pasted URL. Adjusting state during render rather than in an effect:
   * React re-runs this component before touching the DOM, so there is no
   * flash of the stale value and no cascading render.
   *
   * Safe against clobbering a half-typed number because the draft is only
   * published once it has been still for the debounce, so by the time the
   * value comes back around the two already agree.
   */
  const [lastPublished, setLastPublished] = useState(filters.prNumber);
  if (filters.prNumber !== lastPublished) {
    setLastPublished(filters.prNumber);
    setPrDraft(asText(filters.prNumber));
  }

  useEffect(() => {
    if (settledPr === "") {
      if (filters.prNumber !== undefined) onChange({ prNumber: undefined });
      return;
    }
    // Invalid input is left alone rather than pushed to the URL: it would
    // degrade to "no filter" on the way back in, which reads as the box
    // silently clearing itself while you are still typing.
    if (!isValidPrNumber(settledPr)) return;
    const parsed = Number(settledPr);
    if (parsed !== filters.prNumber) onChange({ prNumber: parsed });
    // Publishes the settled draft outward. `filters.prNumber` stays out of the
    // dependencies: reacting to the value coming back in is what the render
    // adjustment above is for, and doing both here would have them fight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledPr]);

  const invalidPr = prDraft.trim() !== "" && !isValidPrNumber(prDraft.trim());

  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field label="Repository" className="min-w-[14rem]">
        {(props) => (
          <Select
            {...props}
            value={filters.repoId ?? ""}
            onChange={(event) =>
              onChange({ repoId: event.target.value || undefined })
            }
          >
            {/* Maps to *no* parameter, not to an empty one. */}
            <option value="">All repositories</option>
            {repos.data?.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.full_name}
              </option>
            ))}
          </Select>
        )}
      </Field>

      {/* "PR number", not "Pull request": the trigger modal already has a
          field by that name, and two controls with the same accessible name
          on one page is a problem for anyone navigating by label. */}
      <Field
        label="PR number"
        error={invalidPr ? "Digits only." : null}
        className="w-32"
      >
        {(props) => (
          <Input
            {...props}
            inputMode="numeric"
            placeholder="Any"
            value={prDraft}
            onChange={(event) => setPrDraft(event.target.value)}
          />
        )}
      </Field>

      <Field label="Status" className="min-w-[10rem]">
        {(props) => (
          <Select
            {...props}
            value={filters.status ?? ""}
            onChange={(event) =>
              onChange({
                status: (event.target.value || undefined) as
                  | ReviewStatus
                  | undefined,
              })
            }
          >
            <option value="">Any status</option>
            {REVIEW_STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <Field label="Order" className="min-w-[10rem]">
        {(props) => (
          <Select
            {...props}
            value={filters.sort}
            onChange={(event) =>
              onChange({ sort: event.target.value as ReviewFilters["sort"] })
            }
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </Select>
        )}
      </Field>

      {/* Only rendered when there is something to clear. Filters persist in
          the URL, which makes them easy to forget about a day later and then
          read as "Liffy lost my reviews" — this is the way back. */}
      {hasActiveFilters(filters) && (
        <Button variant="ghost" onClick={onClear} className="mb-px">
          Clear filters
        </Button>
      )}
    </div>
  );
}
