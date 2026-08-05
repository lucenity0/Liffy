import { Sheet } from "@/components/ui/Sheet";
import { SeverityBadge } from "@/components/ui/badgeMaps";
import { formatPercent } from "@/lib/utils";
import type { SeverityCalibrationRow, Severity } from "@/types/api";

/**
 * Is Liffy's severity labelling calibrated — do the PRs it calls critical
 * actually behave differently from the ones it calls info?
 *
 * A table, not a chart. Three rows of counts and one rate does not need axes,
 * and a chart would push the sample sizes into a tooltip — which is the one
 * thing that must stay next to the rate. §8.1 calls this a monthly audit
 * precisely because n is tiny.
 */
export function SeverityCalibration({
  rows,
}: {
  rows: SeverityCalibrationRow[];
}) {
  return (
    <Sheet aria-label="Severity calibration" data-liffy="analytics-chart">
      <Sheet.Header title="Severity calibration" />

      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-rule bg-recessed">
              <Th>Severity</Th>
              <Th>Comments</Th>
              <Th>PRs</Th>
              {/*
                `still_open_rate`, spelled the way #193 spells it. GitHub's
                REST `state` is `open` or `closed` and does not distinguish
                merged from closed-without-merging, so this measures "not yet
                resolved". The words "blocked merge" describe something the
                data cannot support and must not reach the screen.
              */}
              <Th>Still open</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {rows.map((row) => (
              <tr key={row.severity}>
                <Td>
                  <SeverityBadge value={row.severity as Severity} />
                </Td>
                <Td numeric>{row.comments}</Td>
                {/* The sample size, in its own column rather than in a
                    footnote — a rate quoted without its n is exactly what
                    #193 returns this number to prevent. */}
                <Td numeric>{row.prs_with_comment}</Td>
                <Td numeric>
                  {row.still_open_rate === null ? (
                    // No PRs carry a comment at this severity, so there is no
                    // rate. An em dash, never 0% — nothing was measured.
                    <span className="text-ink-dim">—</span>
                  ) : (
                    <>
                      {formatPercent(row.still_open_rate)}{" "}
                      <span className="text-ink-dim">
                        ({row.prs_still_open} of {row.prs_with_comment})
                      </span>
                    </>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Sheet.Footer>
        <p className="text-sm text-ink-dim">
          "Still open" counts pull requests carrying at least one comment at
          that severity that are not yet closed. GitHub's API does not
          distinguish merged from closed-without-merging, so this is a proxy
          for unresolved, not a measure of Liffy's effect on merges.
        </p>
      </Sheet.Footer>
    </Sheet>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="label px-4 py-2.5 text-ink-dim">{children}</th>;
}

function Td({
  children,
  numeric,
}: {
  children: React.ReactNode;
  numeric?: boolean;
}) {
  return (
    <td className="px-4 py-2.5 text-base text-ink" data-numeric={numeric}>
      {children}
    </td>
  );
}
