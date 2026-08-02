import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { useRepos } from "@/hooks/useRepos";
import { isValidPrNumber } from "@/lib/validators";
import { isNonDefaultView, type ReviewFilters } from "@/lib/pagination";
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
 * Stateless: every filter is owned by the URL and handed down, so the parent
 * stays the single place that knows how to change one — which is also where
 * the offset reset lives.
 *
 * That includes the PR number box, whose draft is the parent's too. It is the
 * one control whose displayed value can differ from the filter — it renders
 * every keystroke while only filtering once typing settles — and reconciling
 * those two has to happen wherever the URL is written, not here. See
 * `Reviews`.
 */
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
            onChange={(event) => onPrDraftChange(event.target.value)}
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

      {/* Only rendered when there is something to clear — which includes a
          non-default order, because clearing resets that too. Filters persist
          in the URL, which makes them easy to forget about a day later and
          then read as "Liffy lost my reviews" — this is the way back. */}
      {isNonDefaultView(filters) && (
        <Button variant="ghost" onClick={onClear} className="mb-px">
          Clear filters
        </Button>
      )}
    </div>
  );
}
