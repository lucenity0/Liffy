/**
 * Shown only in a static showcase build (VITE_DEMO=true).
 *
 * The data behind a demo build is canned — there is no API, database or worker
 * running. The review it displays is genuine model output captured from a real
 * run, but nothing on screen is live, and a visitor has no way to tell that
 * from the UI alone. Saying so is cheaper than being misunderstood.
 */
export function DemoBanner() {
  if (import.meta.env.VITE_DEMO !== "true") return null;

  return (
    <div
      role="note"
      className="border-b border-rule bg-recessed px-4 py-2 text-center text-sm text-ink-sub"
    >
      <span className="text-ink">Demo build</span> — no backend is running. The
      review shown is real output from{" "}
      <span data-numeric className="text-ink">
        claude-opus-5
      </span>{" "}
      on{" "}
      <a
        href="https://github.com/lucenity0/Liffy/pull/58"
        className="text-ink underline underline-offset-2 hover:text-ink-sub"
        target="_blank"
        rel="noreferrer"
      >
        lucenity0/Liffy#58
      </a>
      , captured from a live run and replayed here from fixtures.
    </div>
  );
}
