import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The page's title block, and the rule that closes it.
 *
 * Every page was opening with a heading, a subtitle and then content, with
 * nothing but whitespace between the three — so the title, its description
 * and the first section all read as one undifferentiated stack and the page
 * felt like it was floating. The rule is the fix: it terminates the header,
 * and everything below it is unambiguously content.
 *
 *   TITLE                                    [ PRIMARY ACTION ]
 *   Short description explaining the page.
 *   ─────────────────────────────────────────────────────────
 *
 * The action sits on the title's baseline rather than below the description,
 * because it acts on the page as a whole — the same reason it is the only
 * button allowed at this level.
 */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** The page's one primary action. Section actions belong on the section. */
  actions?: ReactNode;
  className?: string;
}) {
  return (
    /* border-b-2 on --rule-strong, not a hairline on --rule. This rule has a
       different job from every other line in the app: the rest divide peers
       inside a panel, this one separates the page's identity from the page's
       content. At 1px in the standard rule colour it read as one more
       hairline and the header still floated. It is meant to look drawn. */
    <header
      className={cn(
        "flex flex-col gap-1.5 border-b-2 border-rule-strong pb-4",
        className,
      )}
    >
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <h1 className="font-hand text-xl leading-tight text-ink">{title}</h1>
        {actions && (
          <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>
        )}
      </div>
      {description && (
        <p className="max-w-prose text-base text-ink-dim">{description}</p>
      )}
    </header>
  );
}

/**
 * A section within a page, with its own optional secondary action.
 *
 * Deliberately quieter than PageHeader: the label idiom rather than a display
 * face, and no rule. One ruled line per page is a structure; several is a
 * form.
 *
 *   SECTION                                     Secondary action →
 */
export function SectionHeader({
  title,
  count,
  actions,
  className,
}: {
  title: ReactNode;
  /** GitHub's counter chip. Omit while the count is still unknown. */
  count?: number;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <h2 className="label text-ink">{title}</h2>
      {count !== undefined && (
        <span data-numeric className="label text-ink-sub">
          {count}
        </span>
      )}
      {actions && (
        <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
