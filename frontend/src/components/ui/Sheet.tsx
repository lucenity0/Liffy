/* eslint-disable react-refresh/only-export-components --
 * The compound `Sheet.Header` API is assembled with Object.assign, and
 * react-refresh cannot see components behind that. The cost is a full reload
 * instead of a fast refresh when editing this file — the right trade for a
 * container primitive that rarely changes, and the call site is worth more
 * than the HMR nicety. */
import type { ComponentPropsWithoutRef, HTMLAttributes, ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

/**
 * The Sheet — GitHub's "Box", rendered as a leaf of paper.
 *
 * A bordered container with a filled header and hairline-divided rows. It is
 * the most reused thing in the app: repo cards, the reviews table, comment
 * groups, the summary block, lifecycle panels and the modal body are all
 * Sheets.
 *
 * One rule keeps it composable: **the root owns the border and the shadow;
 * the parts own only their fill and their dividers.** That is what stops a
 * Sheet inside a Sheet from drawing doubled hairlines — nest with
 * `tone="flush"`.
 *
 * Assembled with Object.assign rather than context (there is no shared
 * state) and without polymorphic `as` generics (Sheet.Row picks Link vs div
 * from the presence of `to`), because neither buys anything a user can see.
 */

type SheetTone = "default" | "recessed" | "flush";

const TONE: Record<SheetTone, string> = {
  default: "border border-rule bg-card shadow-hard",
  recessed: "border border-rule bg-recessed",
  flush: "bg-transparent",
};

interface SheetProps extends ComponentPropsWithoutRef<"section"> {
  tone?: SheetTone;
}

function SheetRoot({
  tone = "default",
  className,
  children,
  ...rest
}: SheetProps) {
  return (
    <section
      className={cn("rounded-sheet overflow-hidden", TONE[tone], className)}
      {...rest}
    >
      {children}
    </section>
  );
}

// `title` is omitted from the div props: the native attribute is a string
// tooltip, and ours is a ReactNode heading.
interface SheetHeaderProps extends Omit<ComponentPropsWithoutRef<"div">, "title"> {
  title?: ReactNode;
  /** GitHub's counter chip. Omit while the count is still unknown. */
  count?: number;
  actions?: ReactNode;
}

function SheetHeader({
  title,
  count,
  actions,
  className,
  children,
  ...rest
}: SheetHeaderProps) {
  return (
    <div
      className={cn(
        "flex min-h-11 items-center gap-3 border-b border-rule bg-recessed px-4 py-2.5",
        className,
      )}
      {...rest}
    >
      {children ?? (
        <>
          <h2 className="label text-ink">{title}</h2>
          {count !== undefined && (
            <span
              data-numeric
              className="rounded-full bg-rule px-1.5 py-px text-2xs text-ink-dim"
            >
              {count}
            </span>
          )}
        </>
      )}
      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </div>
  );
}

interface SheetBodyProps extends ComponentPropsWithoutRef<"div"> {
  padded?: boolean;
}

function SheetBody({
  padded = true,
  className,
  children,
  ...rest
}: SheetBodyProps) {
  return (
    <div className={cn(padded && "px-4 py-4", className)} {...rest}>
      {children}
    </div>
  );
}

// HTMLAttributes<HTMLElement> rather than the "div" props, because these get
// spread onto a <ul> too and the element-specific handler types differ.
interface SheetListProps extends HTMLAttributes<HTMLElement> {
  as?: "ul" | "div";
}

function SheetList({ as = "div", className, children, ...rest }: SheetListProps) {
  const Element = as;
  return (
    <Element className={cn("divide-y divide-rule", className)} {...rest}>
      {children}
    </Element>
  );
}

interface SheetRowProps extends ComponentPropsWithoutRef<"div"> {
  /** Present => the whole row is a Link. Absent => a plain div. */
  to?: string;
  active?: boolean;
}

function SheetRow({ to, active, className, children, ...rest }: SheetRowProps) {
  const classes = cn(
    "flex items-center gap-3 px-4 py-3",
    to && "hover:bg-recessed focus-visible:bg-recessed",
    active && "bg-recessed",
    className,
  );

  if (to) {
    // No `block` here: it would beat the `flex` above in the cascade and
    // silently kill every `ml-auto` a caller puts on a trailing cell.
    return (
      <Link to={to} className={cn(classes, "text-ink no-underline")}>
        {children}
      </Link>
    );
  }

  return (
    <div className={classes} {...rest}>
      {children}
    </div>
  );
}

function SheetFooter({
  className,
  children,
  ...rest
}: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-t border-rule bg-recessed px-4 py-2.5",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export const Sheet = Object.assign(SheetRoot, {
  Header: SheetHeader,
  Body: SheetBody,
  List: SheetList,
  Row: SheetRow,
  Footer: SheetFooter,
});
