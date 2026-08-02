import { Sheet } from "@/components/ui/Sheet";
import { formatCount, formatDuration } from "@/lib/utils";
import type { ReviewDetailOut } from "@/types/api";

/**
 * What Liffy made of the pull request, before any individual finding.
 *
 * The prose sentence stays set in font-hand at the ruled line-height — it is
 * the part a model wrote, and it reads as marginalia. What is new around it is
 * structure: what the pull request *does*, and what changed in each file.
 *
 * A paragraph gets skimmed. A short list and a table get read, and they carry
 * the review even when it found nothing worth commenting on — which is a
 * common and correct outcome that used to leave this panel looking empty.
 *
 * Every section is optional and independently so. A review from before this
 * existed, or from a model that returned only prose, renders exactly as it did
 * before rather than as a page of empty headings.
 */
export function ReviewSummary({ review }: { review: ReviewDetailOut }) {
  const meta = [
    review.model_used,
    review.tokens_used !== null
      ? `${formatCount(review.tokens_used)} tokens`
      : null,
    review.completed_at
      ? formatDuration(review.created_at, review.completed_at)
      : null,
  ].filter(Boolean);

  const changes = review.summary_detail?.changes ?? [];
  const files = review.summary_detail?.files ?? [];

  return (
    <Sheet>
      <Sheet.Header title="Summary" />
      <Sheet.Body className="flex flex-col gap-5">
        {review.summary ? (
          <p className="prose-hand">{review.summary}</p>
        ) : (
          <p className="text-base text-ink-dim">
            This review finished without a summary.
          </p>
        )}

        {changes.length > 0 && (
          <div className="flex flex-col gap-2">
            <h3 className="label text-ink-dim">Changes</h3>
            <ul className="flex flex-col gap-1.5">
              {changes.map((change, i) => (
                <li key={i} className="flex gap-2 text-base text-ink-dim">
                  <span aria-hidden="true" className="select-none text-ink-sub">
                    —
                  </span>
                  <span className="max-w-prose">{change}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {files.length > 0 && (
          <div className="flex flex-col gap-2">
            <h3 className="label text-ink-dim">
              {files.length} file{files.length === 1 ? "" : "s"} reviewed
            </h3>
            {/* Its own scroller: a long path must not widen the page. */}
            <div className="-mx-1 overflow-x-auto px-1">
              <table className="w-full border-collapse text-sm">
                <tbody>
                  {files.map((file) => (
                    <tr key={file.path} className="border-t border-rule align-baseline">
                      <td className="whitespace-nowrap py-2 pr-4 text-ink">
                        <code className="text-xs">{file.path}</code>
                      </td>
                      <td className="py-2 text-ink-dim">{file.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Sheet.Body>

      {meta.length > 0 && (
        <Sheet.Footer>
          {/* Not the `label` utility: it uppercases, and a model name is a
              proper noun — "GPT-4O" is simply wrong. */}
          <p className="text-sm text-ink-dim" data-numeric>
            {meta.join(" · ")}
          </p>
        </Sheet.Footer>
      )}
    </Sheet>
  );
}
