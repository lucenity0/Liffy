import { IndexBadge } from "@/components/ui/badgeMaps";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatAbsolute, formatCount, formatRelative } from "@/lib/utils";
import type { RepoStatusOut } from "@/types/api";

/**
 * The index chip and its one line of detail. Dumb on purpose — the poll that
 * keeps `status` moving lives in the card's container, not here.
 *
 * `fallbackIndexedAt` comes from GET /repos, which already carries
 * `indexed_at`. It is what gets rendered when the *status* request fails: we
 * still know whether the repo has ever been indexed, just not how many chunks
 * came out of it. Better than a card with a hole in it.
 */
export function IndexStatus({
  status,
  isPending = false,
  fallbackIndexedAt,
}: {
  status?: RepoStatusOut;
  isPending?: boolean;
  fallbackIndexedAt: string | null;
}) {
  if (isPending) {
    return <Skeleton className="w-48" />;
  }

  if (!status) {
    return (
      <Row>
        <IndexBadge value={fallbackIndexedAt ? "indexed" : "not_indexed"} />
        <Meta>index status unavailable</Meta>
      </Row>
    );
  }

  if (status.status === "indexed") {
    // Only a positive count is a caveat. `0` means the run measured and
    // nothing failed; `null` means the repo predates the counter. Neither
    // deserves "0 files skipped" cluttering a healthy chip.
    const skipped = status.last_index_failed_files ?? 0;

    return (
      <Row>
        <IndexBadge value="indexed" />
        <Meta>
          <span data-numeric>{formatCount(status.chunk_count)}</span> chunks
          {skipped > 0 && (
            <>
              {" · "}
              {/* Not colour-only, and not a badge: this is a qualification of
                  the number beside it, so it reads as one. The `seen` total is
                  the denominator — "40 skipped" means something different out
                  of 45 than out of 4,000. */}
              <span className="text-ochre" title={SKIPPED_TITLE}>
                <span data-numeric>{formatCount(skipped)}</span>
                {status.last_indexed_files_seen != null && (
                  <>
                    {" of "}
                    <span data-numeric>
                      {formatCount(status.last_indexed_files_seen)}
                    </span>
                  </>
                )}
                {" files skipped"}
              </span>
            </>
          )}
          {status.indexed_at && (
            <>
              {" · "}
              <time
                dateTime={status.indexed_at}
                title={formatAbsolute(status.indexed_at)}
              >
                {formatRelative(status.indexed_at)}
              </time>
            </>
          )}
        </Meta>
      </Row>
    );
  }

  return (
    <Row>
      <IndexBadge value="not_indexed" />
      {/* aria-live so a screen reader hears the flip to "indexed" that the
          5s poll produces, rather than only seeing it on the next visit. */}
      <Meta aria-live="polite">building the index — this can take a while</Meta>
    </Row>
  );
}

/**
 * What a skipped file actually costs, since the count alone does not say.
 * *Which* files stays in the worker log — the count is the signal, and a repo
 * card is the wrong place for a list.
 */
const SKIPPED_TITLE =
  "These files could not be fetched or chunked on the last run, so they have " +
  "no embeddings. Reviews touching them retrieve no context. Re-index to retry.";

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

function Meta({
  children,
  ...rest
}: React.ComponentPropsWithoutRef<"p">) {
  return (
    <p className="text-sm text-ink-dim" {...rest}>
      {children}
    </p>
  );
}
