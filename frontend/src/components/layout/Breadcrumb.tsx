import { Link } from "react-router-dom";
import { Fragment } from "react";

export interface Crumb {
  label: string;
  /** Omit on the last segment — the current page is not a link. */
  to?: string;
  /** File paths, PR numbers and repo names read better in Argon. */
  mono?: boolean;
}

/**
 * GitHub's `owner / repo` trail, in paper. The separator is a real slash
 * rather than a chevron — it is the same character the API uses in
 * `full_name`, so the trail reads as the identifier it actually is.
 */
export function Breadcrumb({ segments }: { segments: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex items-center gap-1.5 text-sm">
        {segments.map((segment, index) => {
          const isLast = index === segments.length - 1;
          return (
            <Fragment key={`${segment.label}-${index}`}>
              {index > 0 && (
                <li aria-hidden="true" className="text-ink-sub select-none">
                  /
                </li>
              )}
              <li className="min-w-0 truncate">
                {segment.to && !isLast ? (
                  <Link
                    to={segment.to}
                    className={`text-ink-dim hover:text-ink hover:underline underline-offset-3 ${
                      segment.mono ? "font-code" : ""
                    }`}
                  >
                    {segment.label}
                  </Link>
                ) : (
                  <span
                    aria-current={isLast ? "page" : undefined}
                    className={`text-ink ${segment.mono ? "font-code" : ""}`}
                  >
                    {segment.label}
                  </span>
                )}
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
