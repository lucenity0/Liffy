/**
 * Diagrams a help page can ask for by name.
 *
 * The corpus names a figure in its front matter and the drawing lives here.
 * That split is deliberate: a markdown document can never carry markup into
 * the page, which matters on an endpoint that needs no session — and it means
 * an illustration can be redrawn without touching the words it illustrates.
 *
 * **These are static, and that is the second attempt.** The first port brought
 * the landing page's scroll-scrubbed sequences across: a tall track with a
 * sticky frame, progress driven by scroll position. On the marketing page that
 * works because the sequence *is* the content. Dropped into a help answer it
 * put a 240vh dead column between the figure and the first paragraph — the
 * reader scrolled through most of a screen of nothing to reach the words the
 * figure was illustrating.
 *
 * A reference figure has a different job from a marketing one. It is looked at
 * while reading, often re-read, and frequently arrived at by deep link with a
 * specific question. It should be legible in one glance, at its final state,
 * with nothing to operate.
 */

/** A labelled stage in a pipeline diagram. */
function Stage({
  index,
  title,
  detail,
  children,
}: {
  index: number;
  title: string;
  detail: string;
  children?: React.ReactNode;
}) {
  return (
    <li className="flex min-w-0 flex-1 flex-col gap-2 rounded border border-rule bg-recessed p-3">
      <div className="flex items-baseline gap-2">
        <span data-numeric className="text-2xs text-ink-sub">
          {String(index).padStart(2, "0")}
        </span>
        <span className="text-sm text-ink">{title}</span>
      </div>
      <p className="text-xs leading-snug text-ink-dim">{detail}</p>
      {children}
    </li>
  );
}

function HowItWorks() {
  return (
    <figure className="m-0 flex flex-col gap-3">
      <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Stage
          index={1}
          title="Connect a repo"
          detail="You point Liffy at a repository. This is the only step you do."
        />
        <Stage
          index={2}
          title="It reads everything"
          detail="Every file is chunked and embedded into an index Liffy can search later."
        />
        <Stage
          index={3}
          title="A PR arrives"
          detail="The diff, plus related code recalled from the index, goes to the model."
        />
        <Stage
          index={4}
          title="You score it"
          detail="A thumbs up or down on each comment — the only signal Liffy gets."
        />
      </ol>

      {/*
        The claim that does not sound believable written down, shown instead:
        a comment about a file the diff never touched. Static, because the
        point is the *relationship* between the three panels, and a reader
        comparing them wants all three on screen at once.
      */}
      <div className="grid gap-2 rounded border border-rule bg-recessed p-3 text-2xs leading-relaxed lg:grid-cols-3">
        <div>
          <div className="mb-1 text-ink-sub">the diff</div>
          <div className="text-ink-dim">
            <div>
              <span className="text-ink-sub">43</span> + total = subtotal * 1.2
            </div>
          </div>
        </div>
        <div>
          <div className="mb-1 text-ink-sub">recalled from the index</div>
          <div className="text-ink-dim">
            <div>billing/tax.py</div>
            <div>orders/model.py</div>
          </div>
        </div>
        <div>
          <div className="mb-1 text-ink-sub">the comment</div>
          <div className="text-ink">
            VAT is applied twice — <code>billing/tax.py</code> already adds it.
          </div>
        </div>
      </div>
      <figcaption className="text-xs text-ink-sub">
        Neither recalled file appears in the diff. That is what retrieval buys.
      </figcaption>
    </figure>
  );
}

/** The store, at rest: filled, with the five nearest chunks marked. */
function VectorStore() {
  const hits = new Set([14, 37, 52, 88, 103]);
  return (
    <div
      className="grid gap-px"
      style={{ gridTemplateColumns: "repeat(20, minmax(0, 1fr))" }}
      aria-hidden="true"
    >
      {Array.from({ length: 120 }, (_, i) => (
        <span
          key={i}
          className={`aspect-square ${hits.has(i) ? "bg-ink" : "bg-ink-sub/40"}`}
        />
      ))}
    </div>
  );
}

function Indexing() {
  return (
    <figure className="m-0 flex flex-col gap-3">
      <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Stage index={1} title="Your repo" detail="Every file Liffy can read — 412 in this example." />
        <Stage
          index={2}
          title="Split"
          detail="Cut at function and class boundaries, not every N lines, so a chunk is a whole thought."
        />
        <Stage index={3} title="Embed" detail="4,062 chunks, embedded locally and stored in Chroma." />
        <Stage
          index={4}
          title="Recall"
          detail="A review pulls back only the handful of chunks related to its diff."
        />
      </ol>

      <div className="flex flex-col gap-2 rounded border border-rule bg-recessed p-3">
        <div className="flex items-baseline justify-between text-2xs text-ink-sub">
          <span>vector store · 4,062 chunks</span>
          <span>5 nearest → sent to the model</span>
        </div>
        <VectorStore />
      </div>
      <figcaption className="text-xs text-ink-sub">
        The five marked chunks are scattered, not adjacent. Related code is
        related by meaning, not by where it happens to sit in the repository.
      </figcaption>
    </figure>
  );
}

const FIGURES: Record<string, () => React.ReactElement> = {
  "how-it-works": HowItWorks,
  indexing: Indexing,
};

/**
 * Renders nothing for an unknown name rather than throwing. A figure is
 * decoration on top of an answer that stands on its own — a corpus typo
 * should cost the picture, never the page.
 */
export function Figure({ name }: { name: string }) {
  const Component = FIGURES[name];
  if (!Component) return null;
  return <Component />;
}
