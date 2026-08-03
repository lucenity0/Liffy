import type { ReactNode } from "react";

/**
 * A deliberately tiny markdown renderer for the help corpus.
 *
 * No dependency, and — more importantly — no `dangerouslySetInnerHTML`. Every
 * construct below becomes a React element, so there is no path by which text
 * from a document becomes markup. That matters more here than in most places:
 * the corpus is the one body of text in Liffy that is rendered verbatim rather
 * than escaped into a data cell, and `/help` is readable without a session.
 *
 * It supports exactly what `app/help/*.md` uses — paragraphs, bullet lists,
 * `code`, **bold**. Anything else renders as its literal text, which is the
 * right failure: a stray construct looks slightly wrong instead of vanishing.
 * If the corpus grows a table or a heading, teach this file about it rather
 * than reaching for a library.
 */

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`)/g;

function inline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong key={key} className="font-medium text-ink">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code
          key={key}
          className="rounded-chip border border-rule bg-recessed px-1 py-px text-[0.9em]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={key}>{part}</span>;
  });
}

const BULLET = /^\s*[-*]\s+/;

export function Prose({ markdown }: { markdown: string }) {
  const blocks = markdown.replace(/\r\n/g, "\n").split(/\n{2,}/);

  return (
    <div className="flex flex-col gap-4 text-base leading-relaxed text-ink-dim">
      {blocks.map((block, blockIndex) => {
        const lines = block.split("\n").filter((l) => l.trim());
        if (lines.length === 0) return null;

        if (lines.every((line) => BULLET.test(line))) {
          return (
            <ul key={blockIndex} className="flex flex-col gap-2 pl-1">
              {lines.map((line, i) => (
                <li key={i} className="flex gap-2">
                  <span aria-hidden="true" className="select-none text-ink-sub">
                    —
                  </span>
                  <span>{inline(line.replace(BULLET, ""), `${blockIndex}-${i}`)}</span>
                </li>
              ))}
            </ul>
          );
        }

        // Hard-wrapped paragraphs: the corpus wraps at ~80 columns, and those
        // newlines are an authoring convenience, not line breaks anyone meant.
        return (
          <p key={blockIndex} className="max-w-prose">
            {inline(lines.join(" "), String(blockIndex))}
          </p>
        );
      })}
    </div>
  );
}
