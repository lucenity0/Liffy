import { clamp01, stageOf } from "@/lib/scrolly";
import { Rail, ScrollyTrack } from "./Scrolly";

/**
 * "How Liffy reads a codebase", scrubbed by scroll.
 *
 * A port of the landing page's second scrolly sequence, and deliberately the
 * same four beats in the same order: your repo, split, embed, recall. Someone
 * who watched it on the marketing site and then opens Help should recognise
 * the figure rather than have to learn a second diagram of the same thing.
 *
 * The sequence shows the two claims that are hard to believe in prose — that
 * chunks are cut at function boundaries rather than every N lines, and that
 * a query pulls back a *scattered* handful rather than a tidy neighbouring
 * block. Both are shown here rather than asserted.
 */

const FILES = [
  { name: "backend/app/services/rag_service.py", chunks: "12 chunks" },
  { name: "backend/app/services/chunker.py", chunks: "9 chunks" },
  { name: "backend/app/config.py", chunks: "4 chunks" },
  { name: "setup-mac.sh", chunks: "6 chunks" },
  { name: "setup-windows.bat", chunks: "5 chunks" },
];

const CELLS = 120;
/** Scattered, not adjacent — the nearest chunks to a query are not neighbours,
 *  and a tidy row would quietly imply they were. */
const HITS = new Set([14, 37, 52, 88, 103]);
const HIT_FILES = new Set([3, 4]);

const STEPS = ["your repo", "split", "embed", "recall"];
const NOTES = ["412 files", "splitting …", "embedding …", "ready"];
const BOUNDS = [0.2, 0.45, 0.75];
const TOTAL_CHUNKS = 4062;

export function ScrollyIndexing() {
  return (
    <ScrollyTrack label="How Liffy reads a codebase" height="240vh">
      {(p) => {
        const stage = stageOf(p, BOUNDS);
        const splitP = clamp01((p - 0.2) / 0.25);
        const fillP = clamp01((p - 0.45) / 0.3);
        const filled = Math.round(fillP * CELLS);
        const recall = stage >= 3;

        return (
          <figure className="m-0 overflow-hidden rounded border border-rule bg-card">
            <figcaption className="flex items-center justify-between border-b border-rule bg-recessed px-3 py-1.5 text-2xs text-ink-sub">
              <span>indexing lucenity0/Liffy</span>
              <span data-numeric>{NOTES[stage]}</span>
            </figcaption>

            <div className="px-3 pt-3">
              <Rail steps={STEPS} stage={stage} />
            </div>

            <div className="grid gap-3 px-3 pb-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
              <div className="flex flex-col gap-1">
                {FILES.map((file, i) => {
                  const split = splitP > i / FILES.length;
                  const hit = recall && HIT_FILES.has(i);
                  return (
                    <div
                      key={file.name}
                      className={[
                        "flex items-baseline justify-between gap-2 border-l-2 py-0.5 pl-2 text-2xs transition-colors duration-200",
                        hit
                          ? "border-ink text-ink"
                          : split
                            ? "border-rule-strong text-ink-dim"
                            : "border-transparent text-ink-sub",
                      ].join(" ")}
                    >
                      <span className="truncate">{file.name}</span>
                      <span
                        data-numeric
                        className={split ? "opacity-100" : "opacity-0"}
                        style={{ transition: "opacity 200ms" }}
                      >
                        {file.chunks}
                      </span>
                    </div>
                  );
                })}

                {/* Shown, not asserted: the cut lands on the function, not on
                    a line count. */}
                <div
                  className="mt-2 rounded border border-rule bg-recessed p-2 text-2xs leading-relaxed text-ink-dim"
                  style={{
                    opacity: stage >= 1 ? 1 : 0,
                    transition: "opacity 250ms",
                  }}
                >
                  <div className="text-ink-sub">┌ chunk 04</div>
                  <div className="text-ink">
                    &nbsp;&nbsp;def write_secret(env_path, secret):
                  </div>
                  <div>&nbsp;&nbsp;&nbsp;&nbsp;replace the JWT_SECRET_KEY line in place</div>
                  <div className="text-ink-sub">
                    └ cut at the function boundary, not at line 40
                  </div>
                </div>

                <div
                  className="mt-2 flex flex-wrap items-baseline gap-2 text-2xs"
                  style={{ opacity: recall ? 1 : 0, transition: "opacity 250ms" }}
                >
                  <span className="rounded border border-rule px-1 text-ink-sub">
                    query
                  </span>
                  <span className="text-ink-dim">
                    “how does this project write the signing secret into .env?”
                  </span>
                </div>
              </div>

              <aside className="flex flex-col gap-2">
                <div className="text-2xs text-ink-sub">
                  vector store ·{" "}
                  <span data-numeric className="text-ink-dim">
                    {Math.round(fillP * TOTAL_CHUNKS).toLocaleString("en-US")}
                  </span>
                </div>
                <div
                  className="grid gap-px"
                  style={{ gridTemplateColumns: "repeat(12, minmax(0, 1fr))" }}
                  aria-hidden="true"
                >
                  {Array.from({ length: CELLS }, (_, i) => (
                    <span
                      key={i}
                      className={[
                        "aspect-square transition-colors duration-150",
                        recall && HITS.has(i)
                          ? "bg-ink"
                          : i < filled
                            ? "bg-ink-sub"
                            : "bg-rule/40",
                      ].join(" ")}
                    />
                  ))}
                </div>
                <p
                  className="text-2xs text-ink-dim"
                  style={{ opacity: recall ? 1 : 0, transition: "opacity 250ms" }}
                >
                  5 nearest → sent to the model
                </p>
              </aside>
            </div>

            <div
              className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-rule bg-recessed px-3 py-2 text-2xs text-ink-sub"
              style={{ opacity: stage >= 3 ? 1 : 0.35, transition: "opacity 250ms" }}
            >
              <span className="text-ink">indexed</span>
              <span>
                files <b data-numeric className="text-ink-dim">412</b>
              </span>
              <span>
                chunks <b data-numeric className="text-ink-dim">4,062</b>
              </span>
              <span>runs once, then only on change</span>
            </div>
          </figure>
        );
      }}
    </ScrollyTrack>
  );
}
