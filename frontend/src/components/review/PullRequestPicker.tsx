import { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Input } from "@/components/ui/Field";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { usePullRequests } from "@/hooks/usePullRequests";
import { cn } from "@/lib/utils";

type State = "open" | "closed";

/**
 * Which pull request, chosen from a list rather than typed from a URL.
 *
 * Starting a review used to begin with going to GitHub, finding the pull
 * request, and copying the number out of the address bar. `GET
 * /repos/{id}/pulls` exists so this step can be a list.
 *
 * Still degrades to a number. The endpoint proxies GitHub live, so it can
 * rate-limit or fail on a repository the caller's token cannot see — and
 * "the picker is broken so you cannot start a review" would be a worse
 * product than the typing it replaced.
 */
export function PullRequestPicker({
  repoId,
  value,
  onChange,
  onFallback,
}: {
  repoId: string | null;
  /** The chosen number, or null. */
  value: number | null;
  onChange: (number: number) => void;
  /** Called when the list cannot be shown, so the caller can offer the box. */
  onFallback: () => void;
}) {
  const [state, setState] = useState<State>("open");
  const [query, setQuery] = useState("");
  const pulls = usePullRequests(repoId, state);

  /**
   * The other tab's count, so both read `OPEN 4  CLOSED 28` at once.
   *
   * A second proxied call when the picker opens, not a free one — but a tab
   * whose number only appears after you press it cannot tell you whether it
   * is worth pressing, which is the entire job of a count on a tab.
   */
  const otherState: State = state === "open" ? "closed" : "open";
  const other = usePullRequests(repoId, otherState);
  const counts: Record<State, number | null | undefined> = {
    [state]: pulls.data?.total,
    [otherState]: other.data?.total,
  } as Record<State, number | null | undefined>;

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const items = pulls.data?.items ?? [];
    if (!needle) return items;
    return items.filter(
      (pull) =>
        pull.title.toLowerCase().includes(needle) ||
        String(pull.number).includes(needle) ||
        pull.head_branch.toLowerCase().includes(needle),
    );
  }, [pulls.data, query]);

  if (!repoId) {
    return (
      <p className="text-sm text-ink-dim">Choose a repository first.</p>
    );
  }

  if (pulls.isError) {
    return (
      <div className="flex flex-col gap-2">
        <ErrorNote error={pulls.error} onRetry={() => pulls.refetch()} />
        <button
          type="button"
          onClick={onFallback}
          className="w-fit text-sm text-ink-dim underline underline-offset-4 hover:text-ink"
        >
          Enter a number instead
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {(["open", "closed"] as State[]).map((option) => (
          <Button
            key={option}
            size="sm"
            type="button"
            variant={state === option ? "primary" : "secondary"}
            aria-pressed={state === option}
            onClick={() => setState(option)}
            className="capitalize"
          >
            {option}
            {/* Only when it is provably the whole set — the endpoint returns
                null for a full page rather than reporting "at least 50" as a
                total, and a tab reading "CLOSED 50" on a repository with 900
                closed pull requests is worse than one reading "CLOSED". */}
            {typeof counts[option] === "number" && (
              <span data-numeric className="ml-1.5 opacity-70">
                {counts[option]}
              </span>
            )}
          </Button>
        ))}
      </div>

      <Input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search pull requests…"
        aria-label="Search pull requests"
        className="w-full"
      />

      <div className="max-h-56 overflow-y-auto rounded-sheet border border-rule">
        {pulls.isPending ? (
          <SkeletonRows rows={3} />
        ) : visible.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-ink-dim">
            {query
              ? `No ${state} pull requests match “${query}”.`
              : `No ${state} pull requests.`}
          </p>
        ) : (
          <ul className="divide-y divide-rule">
            {visible.map((pull) => {
              const selected = pull.number === value;
              return (
                <li key={pull.number}>
                  <button
                    type="button"
                    onClick={() => onChange(pull.number)}
                    aria-pressed={selected}
                    className={cn(
                      "flex w-full flex-col gap-0.5 px-3 py-2 text-left",
                      selected
                        ? "bg-neutral-tint text-ink"
                        : "text-ink-dim hover:bg-recessed hover:text-ink",
                    )}
                  >
                    <span className="flex items-baseline gap-2">
                      <span data-numeric className="shrink-0 font-code text-sm">
                        #{pull.number}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-base text-ink">
                        {pull.title}
                      </span>
                    </span>
                    <span className="truncate font-code text-2xs text-ink-sub">
                      {pull.head_branch} → {pull.base_branch}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex items-baseline gap-3">
        <button
          type="button"
          onClick={onFallback}
          className="text-2xs text-ink-sub underline underline-offset-4 hover:text-ink"
        >
          Enter a number instead
        </button>

        {/* What you are looking at, out of what there is. Says "of N" only
            when N is known — one page came back short — and otherwise just
            counts what is on screen rather than implying a total. */}
        {visible.length > 0 && (
          <span data-numeric className="ml-auto text-2xs text-ink-sub">
            {visible.length === 1 ? "1" : `1–${visible.length}`}
            {typeof pulls.data?.total === "number" &&
            visible.length === pulls.data.items.length
              ? ` of ${pulls.data.total}`
              : ""}
          </span>
        )}
      </div>
    </div>
  );
}
