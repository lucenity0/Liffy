import { Sheet } from "@/components/ui/Sheet";
import { CATEGORY_LABELS } from "@/lib/categories";
import { categoryCounts, severityCounts } from "@/lib/reviewStats";
import { formatCount, formatDuration } from "@/lib/utils";
import type { Category, ReviewDetailOut, Severity } from "@/types/api";

const SEVERITY_ORDER: Severity[] = ["critical", "warning", "info"];

const SEVERITY_INK: Record<Severity, string> = {
  critical: "text-oxide",
  warning: "text-ochre",
  info: "text-payne",
};

const CATEGORIES = Object.keys(CATEGORY_LABELS) as Category[];

/**
 * What Liffy made of the pull request, answerable in about three seconds.
 *
 * Order is deliberate: the verdict, then how bad it is, then why, then what
 * moved. Everything file-by-file lives in the Changes tab — this one stops at
 * the point where you would need to start reading code.
 */
export function SummaryTab({ review }: { review: ReviewDetailOut }) {
  const severities = severityCounts(review.comments);
  const categories = categoryCounts(review.comments, CATEGORIES);
  const changes = review.summary_detail?.changes ?? [];
  const busiest = categories[0]?.count ?? 0;

  const meta = [
    review.model_used,
    review.tokens_used !== null
      ? `${formatCount(review.tokens_used)} tokens`
      : null,
    review.completed_at
      ? formatDuration(review.created_at, review.completed_at)
      : null,
  ].filter(Boolean);

  return (
    /**
     * One panel, banded — not three things stacked with air between them.
     *
     * What changed and Review focus used to be bare sections on the page
     * background, so the tab read as a card followed by two paragraphs
     * floating loose beneath it. They are all answers to the same question,
     * so they belong inside the same border, divided rather than separated.
     */
    <Sheet>
      <Sheet.Header title="Review summary" />
      <Sheet.Body className="flex flex-col gap-5">
        {/* No verdict badge here. The brief shows one in the header and
              again at the top of this tab, but the header's is on screen
              whichever tab is open and sits one line above this panel — two
              copies a centimetre apart is not emphasis, it is a stutter. */}
        {review.summary ? (
          <p className="prose-hand">{review.summary}</p>
        ) : (
          <p className="text-base text-ink-dim">
            This review finished without a summary.
          </p>
        )}

        {/* Three bordered regions, not dashboard metric cards. The zeroes
              are the point — "0 critical" is the most reassuring thing this
              page can say, and only says it by being present. */}
        <ul className="grid grid-cols-3 divide-x divide-rule rounded-sheet border border-rule">
          {SEVERITY_ORDER.map((severity) => (
            <li key={severity} className="flex flex-col gap-0.5 px-4 py-3">
              <span
                data-numeric
                className={`font-hand text-xl leading-none ${
                  severities[severity] > 0
                    ? SEVERITY_INK[severity]
                    : "text-ink-sub"
                }`}
              >
                {severities[severity]}
              </span>
              <span className="label">{severity}</span>
            </li>
          ))}
        </ul>
        {meta.length > 0 && (
          /* Inside the first band rather than a Sheet.Footer: the panel now
               runs on past this point, so a footer would have been a closing
               line in the middle of the sheet. */
          <p className="text-sm text-ink-dim" data-numeric>
            {meta.join(" · ")}
          </p>
        )}
      </Sheet.Body>

      {changes.length > 0 && (
        <>
          <Sheet.Header title="What changed" className="border-t border-rule" />
          <Sheet.Body>
            <ul className="flex flex-col gap-1.5">
              {changes.map((change, index) => (
                <li key={index} className="flex gap-2 text-base text-ink-dim">
                  <span aria-hidden="true" className="select-none text-ink-sub">
                    —
                  </span>
                  <span>{change}</span>
                </li>
              ))}
            </ul>
          </Sheet.Body>
        </>
      )}

      {review.comments.length > 0 && (
        <>
          <Sheet.Header
            title="Review focus"
            className="border-t border-rule"
            actions={
              <span className="text-sm text-ink-dim">
                {review.comments.length} comment
                {review.comments.length === 1 ? "" : "s"}
              </span>
            }
          />
          <Sheet.Body>
            {/* CSS bars, not a chart library — the brief says so, and a
              dependency for six horizontal rules would be absurd. */}
            <ul className="flex flex-col gap-1.5">
              {categories.map(({ category, count }) => (
                <li key={category} className="flex items-center gap-3 text-sm">
                  <span className="w-28 shrink-0 text-ink-dim">
                    {CATEGORY_LABELS[category]}
                  </span>
                  <span
                    aria-hidden="true"
                    className="h-2 rounded-chip bg-ink-sub/50"
                    style={{
                      // Widths are relative to the busiest category, so the
                      // shape of the review reads even when every count is low.
                      width: busiest > 0 ? `${(count / busiest) * 100}%` : 0,
                      minWidth: count > 0 ? "0.5rem" : 0,
                    }}
                  />
                  <span
                    data-numeric
                    className={`ml-auto shrink-0 ${count > 0 ? "text-ink" : "text-ink-sub"}`}
                  >
                    {count}
                  </span>
                </li>
              ))}
            </ul>
          </Sheet.Body>
        </>
      )}
    </Sheet>
  );
}
