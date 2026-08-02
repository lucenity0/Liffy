import { clamp01, stageOf } from "@/lib/scrolly";
import { Rail, ScrollyTrack } from "./Scrolly";

/**
 * "Watching Liffy review a pull request", scrubbed by scroll.
 *
 * The landing page's centrepiece, in the same four beats: a PR arrives, the
 * index is searched, the model reads both, a comment lands. Shortened for a
 * help page — the marketing version can afford to linger, an answer cannot.
 *
 * The beat that matters is the third. The comment cites a file the diff never
 * touched, which is the one thing about Liffy that does not sound believable
 * written down: a reviewer that has read the whole codebase notices what a
 * reviewer holding only the diff cannot.
 */

const STEPS = ["a PR arrives", "recall", "read", "comment"];
const BOUNDS = [0.25, 0.5, 0.75];

const DIFF = [
  { n: 41, sign: " ", text: "def charge(order):" },
  { n: 42, sign: "-", text: "    total = order.subtotal" },
  { n: 43, sign: "+", text: "    total = order.subtotal * 1.2" },
  { n: 44, sign: " ", text: "    return gateway.take(total)" },
];

const RECALLED = [
  { file: "billing/tax.py", note: "applies VAT downstream" },
  { file: "orders/model.py", note: "subtotal excludes tax" },
];

export function ScrollyReview() {
  return (
    <ScrollyTrack label="Watching Liffy review a pull request" height="240vh">
      {(p) => {
        const stage = stageOf(p, BOUNDS);
        const typed = clamp01((p - 0.75) / 0.2);

        return (
          <figure className="m-0 overflow-hidden rounded border border-rule bg-card">
            <figcaption className="flex items-center justify-between border-b border-rule bg-recessed px-3 py-1.5 text-2xs text-ink-sub">
              <span>lucenity0/Liffy #58</span>
              <span data-numeric>
                {["webhook received", "searching the index", "reading", "done in 2m 07s"][stage]}
              </span>
            </figcaption>

            <div className="px-3 pt-3">
              <Rail steps={STEPS} stage={stage} />
            </div>

            <div className="flex flex-col gap-3 px-3 pb-3">
              <div className="rounded border border-rule bg-recessed p-2 text-2xs leading-relaxed">
                {DIFF.map((line) => (
                  <div
                    key={line.n}
                    className={
                      line.sign === "+"
                        ? "text-ink"
                        : line.sign === "-"
                          ? "text-ink-sub line-through"
                          : "text-ink-dim"
                    }
                  >
                    <span data-numeric className="mr-2 text-ink-sub">
                      {line.n}
                    </span>
                    {line.sign}
                    {line.text}
                  </div>
                ))}
              </div>

              {/* Stage 2: the index gives back files the diff never mentions. */}
              <div
                className="flex flex-col gap-1"
                style={{ opacity: stage >= 1 ? 1 : 0, transition: "opacity 250ms" }}
              >
                <span className="text-2xs text-ink-sub">
                  retrieved from the index — neither file is in this diff
                </span>
                {RECALLED.map((item) => (
                  <div
                    key={item.file}
                    className="flex items-baseline justify-between gap-2 border-l-2 border-rule-strong py-0.5 pl-2 text-2xs"
                  >
                    <span className="text-ink-dim">{item.file}</span>
                    <span className="text-ink-sub">{item.note}</span>
                  </div>
                ))}
              </div>

              {/* Stage 4: the comment, typed in as you scroll. */}
              <div
                className="rounded border border-rule p-2"
                style={{ opacity: stage >= 3 ? 1 : 0, transition: "opacity 250ms" }}
              >
                <div className="mb-1 flex items-baseline gap-2 text-2xs">
                  <span className="rounded border border-rule px-1 text-ink">
                    logic_error
                  </span>
                  <span className="text-ink-sub">line 43</span>
                </div>
                <p className="text-2xs leading-relaxed text-ink-dim">
                  {"Multiplying by 1.2 here applies VAT a second time — billing/tax.py already adds it downstream, and orders/model.py documents subtotal as tax-exclusive.".slice(
                    0,
                    Math.round(
                      typed *
                        "Multiplying by 1.2 here applies VAT a second time — billing/tax.py already adds it downstream, and orders/model.py documents subtotal as tax-exclusive.".length,
                    ),
                  )}
                  <span className="text-ink-sub">{typed < 1 ? "▏" : ""}</span>
                </p>
              </div>
            </div>
          </figure>
        );
      }}
    </ScrollyTrack>
  );
}
