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
    return (
      <Row>
        <IndexBadge value="indexed" />
        <Meta>
          <span data-numeric>{formatCount(status.chunk_count)}</span> chunks
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
