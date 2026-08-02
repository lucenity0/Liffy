import { Sprite } from "./Sprite";

/**
 * Diagrams a help page can ask for by name.
 *
 * The corpus names a figure in its front matter and the drawing lives here.
 * That split is deliberate: a markdown document can never carry markup into
 * the page, which matters on an endpoint that needs no session — and it means
 * an illustration can be redrawn without touching the words it illustrates.
 *
 * Both figures below are the landing page's, in the landing page's sprites.
 * Someone who arrives from the marketing site and then opens Help should meet
 * the same pictures rather than a second explanation drawn differently.
 */

const STEPS = [
  {
    sprite: "key",
    title: "Connect a repo",
    body: "Point Liffy at a repository. Your keys, your machine.",
  },
  {
    sprite: "book",
    title: "It reads everything",
    body: "Every file chunked and indexed, so a review can find related code.",
  },
  {
    sprite: "eye",
    title: "A PR arrives",
    body: "Liffy reads the diff against everything it knows, then comments.",
  },
  {
    sprite: "star",
    title: "You score it",
    body: "Thumbs up or down. That is how Liffy learns whether it helped.",
  },
];

function HowItWorks() {
  return (
    <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {STEPS.map((step, i) => (
        <li
          key={step.sprite}
          className="flex flex-col gap-2 rounded border border-rule bg-recessed p-3"
        >
          <div className="flex items-center gap-2 text-ink-dim">
            <Sprite name={step.sprite} cell={3} />
            <span data-numeric className="text-2xs text-ink-sub">
              {String(i + 1).padStart(2, "0")}
            </span>
          </div>
          <span className="text-sm text-ink">{step.title}</span>
          <span className="text-xs leading-snug text-ink-sub">{step.body}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * What indexing turns a repository into.
 *
 * Drawn rather than described because the shape is the insight: many files
 * collapse into many chunks, and a review pulls back only the few that relate
 * to the diff. People who picture it as "Liffy reads my whole repo every time"
 * both over-estimate the cost and under-estimate why retrieval helps.
 */
function Indexing() {
  return (
    <div className="flex flex-col gap-3 rounded border border-rule bg-recessed p-4 sm:flex-row sm:items-center sm:gap-4">
      <Stage label="your repo" detail="every file">
        <div className="flex flex-col gap-px" aria-hidden="true">
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="flex gap-px">
              {[0, 1, 2, 3, 4].map((col) => (
                <span key={col} className="h-1.5 w-1.5 bg-ink-sub" />
              ))}
            </div>
          ))}
        </div>
      </Stage>

      <Arrow label="chunked and embedded" />

      <Stage label="the index" detail="stored locally">
        <Sprite name="book" cell={3} className="text-ink-dim" />
      </Stage>

      <Arrow label="a PR arrives" />

      <Stage label="retrieved" detail="only what relates">
        <div className="flex gap-px" aria-hidden="true">
          {[0, 1, 2].map((col) => (
            <span key={col} className="h-1.5 w-1.5 bg-ink" />
          ))}
        </div>
      </Stage>
    </div>
  );
}

function Stage({
  label,
  detail,
  children,
}: {
  label: string;
  detail: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
      <div className="flex h-8 items-end">{children}</div>
      <span className="text-xs text-ink">{label}</span>
      <span className="text-2xs text-ink-sub">{detail}</span>
    </div>
  );
}

function Arrow({ label }: { label: string }) {
  return (
    <div className="flex shrink-0 flex-col items-center gap-1 text-ink-sub">
      <span aria-hidden="true" className="text-sm">
        →
      </span>
      <span className="text-2xs">{label}</span>
    </div>
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
  return (
    <figure className="m-0">
      <Component />
    </figure>
  );
}
