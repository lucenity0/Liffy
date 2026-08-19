import { Fragment } from "react";
import { segments } from "@/lib/modelProse";
import { cn } from "@/lib/utils";

/**
 * Model prose with its inline code spans rendered, and nothing else.
 *
 * Liffy's comments come back peppered with markdown backticks — identifiers,
 * paths, flags — because that is how the model writes about code. Rendered as
 * plain text they read as literal punctuation: "inside a ```cmd block `#` is
 * not a comment marker" is noise where it should be typography.
 *
 * **This is deliberately not a markdown renderer, and must not become one.**
 * Every string here is derived from a diff written by whoever opened the pull
 * request, who on a public repository is a stranger. `defang_model_markdown`
 * on the backend exists because GitHub fetches `![](url)` server-side the
 * moment a comment is posted, turning a review into an exfiltration channel
 * for the retrieved context sitting in the same prompt. Parsing arbitrary
 * markdown here would reopen that hole on our own origin.
 *
 * The safety property is structural rather than a blocklist: this splits a
 * string and returns text nodes and `<code>` elements. There is no path
 * through it that produces an anchor, an image, or raw HTML, so there is
 * nothing for a crafted comment to reach for — no rule to keep up to date,
 * and no escape to get wrong.
 */
export function ModelProse({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <p className={cn("prose-hand", className)}>
      {segments(text).map((segment, i) =>
        segment.code ? (
          <code
            key={i}
            className="rounded-[3px] border border-rule bg-recessed px-1 py-px font-code text-[0.9em] text-ink"
          >
            {segment.text}
          </code>
        ) : (
          <Fragment key={i}>{segment.text}</Fragment>
        ),
      )}
    </p>
  );
}
