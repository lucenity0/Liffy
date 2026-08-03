import { EmptyState } from "@/components/ui/EmptyState";
import { Sheet } from "@/components/ui/Sheet";
import type { FileDiff } from "@/lib/diff";
import { fileStat } from "@/lib/reviewStats";

/**
 * The model's file-by-file account of what moved.
 *
 * Deliberately a dense table rather than a card per file — this is the tab
 * you skim to decide what to open, and 24 cards is a scroll, not a summary.
 *
 * `summary_detail.files` is optional and often absent: it is null on every
 * review written before the structured overview landed, and on any model
 * that answered with prose only. When it is missing the diff still knows
 * which files changed and by how much, so the tab degrades to that rather
 * than disappearing.
 */
export function ChangesTab({
  described,
  files,
}: {
  described: { path: string; description: string }[];
  files: FileDiff[];
}) {
  const byPath = new Map(files.map((file) => [file.path, file]));

  // Described files first, in the model's order; then anything in the diff
  // it did not mention, so the count in the tab always matches the rows.
  const describedPaths = new Set(described.map((entry) => entry.path));
  const rows = [
    ...described.map((entry) => ({
      path: entry.path,
      description: entry.description,
      file: byPath.get(entry.path),
    })),
    ...files
      .filter((file) => !describedPaths.has(file.path))
      .map((file) => ({ path: file.path, description: null, file })),
  ];

  if (rows.length === 0) {
    return (
      <Sheet>
        <EmptyState
          title="Nothing to describe."
          description="This review recorded no file-level change summary."
        />
      </Sheet>
    );
  }

  return (
    <Sheet>
      <Sheet.Header title="Changes" count={rows.length} />
      {/* Its own scroller: a long path must not widen the page. */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-rule text-left">
              <th scope="col" className="label px-4 py-2 font-normal">
                File
              </th>
              <th scope="col" className="label px-4 py-2 font-normal">
                Summary
              </th>
              <th scope="col" className="label px-4 py-2 text-right font-normal">
                Lines
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const stat = row.file ? fileStat(row.file) : null;
              return (
                <tr
                  key={row.path}
                  className="border-b border-rule align-baseline last:border-b-0"
                >
                  <td className="px-4 py-2.5">
                    <code className="font-code text-xs break-all text-ink">
                      {row.path}
                    </code>
                  </td>
                  <td className="px-4 py-2.5 text-ink-dim">
                    {row.description ?? (
                      <span className="text-ink-sub">Not described</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">
                    {stat ? (
                      <span data-numeric className="font-code text-xs">
                        <span className="text-sage">+{stat.additions}</span>{" "}
                        <span className="text-oxide">−{stat.deletions}</span>
                      </span>
                    ) : (
                      <span className="text-ink-sub">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Sheet>
  );
}
