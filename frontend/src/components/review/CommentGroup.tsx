import { SeverityBadge } from "@/components/ui/badgeMaps";
import type { CommentGroup as Group } from "@/lib/reviewUtils";
import { ReviewComment } from "./ReviewComment";

/**
 * One file's worth of comments, collapsible.
 *
 * Native <details> rather than useState: it collapses without JavaScript,
 * Enter and Space work, and the browser's find-in-page can open a closed
 * group to reveal a match — none of which a div and a boolean gets right.
 */
export function CommentGroup({ group }: { group: Group }) {
  return (
    <details open className="group border-b border-rule last:border-b-0">
      <summary className="flex cursor-pointer list-none items-center gap-3 bg-recessed px-4 py-2.5 hover:bg-rule/40 [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden="true"
          className="text-ink-sub transition-transform group-open:rotate-90"
        >
          ›
        </span>
        <span className="font-code text-base break-all text-ink">
          {group.filePath}
        </span>
        <span
          data-numeric
          className="rounded-full bg-rule px-1.5 py-px text-2xs text-ink-dim"
        >
          {group.comments.length}
        </span>
        {/* The worst thing in the file, so a collapsed group still says
            whether it is worth opening. */}
        <span className="ml-auto">
          <SeverityBadge value={group.worst} />
        </span>
      </summary>

      <div className="divide-y divide-rule">
        {group.comments.map((comment) => (
          <ReviewComment key={comment.id} comment={comment} />
        ))}
      </div>
    </details>
  );
}
