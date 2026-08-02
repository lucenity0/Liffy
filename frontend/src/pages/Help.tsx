import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { Spinner } from "@/components/ui/Spinner";
import { Figure } from "@/components/help/Figure";
import { Prose } from "@/components/help/Prose";
import { ReportProblem } from "@/components/help/ReportProblem";
import { useHelpPage, useHelpSearch, useHelpTopics } from "@/hooks/useHelp";
import type { HelpPassage, HelpTopic } from "@/types/api";

/**
 * Liffy's documentation, searchable.
 *
 * **This is not a chat and must never look like one.** It ranks fifteen pages
 * a human wrote and shows one of them; it never composes an answer. The label
 * under the search box says so, and it is load-bearing copy rather than
 * decoration — the whole reason anyone can trust an answer here is that
 * nothing generated it.
 *
 * The URL is the state (`?q=` and `?page=`), which is what a page buys over a
 * modal: answers are linkable, back and forward work, and the rest of the app
 * can deep-link into a specific passage — the failed-review panel does exactly
 * that with the error it is showing.
 */
export function Help() {
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const selectedSlug = params.get("page");

  // The input is local and the URL follows it, not the other way around.
  // Driving the field from the URL makes every keystroke a history entry and
  // makes the cursor jump on re-render.
  const [draft, setDraft] = useState(query);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Nothing to do when the field already agrees with the URL — which is
    // exactly the state on mount, including for a deep link.
    //
    // Without this guard the effect fired 200ms after load and ran
    // `next.delete("page")`, so `/help?q=…&page=subscription-providers` lost
    // its selection and fell back to `results[0]`: "a different answer wearing
    // the right URL", which is the case `useHelpPage` exists to prevent. The
    // test passed only because `waitFor` resolved before the timer fired.
    if (draft.trim() === query) return;

    const timer = setTimeout(() => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (draft.trim()) next.set("q", draft.trim());
          else next.delete("q");
          // A new search invalidates the old selection: keeping it would leave
          // the reading pane showing a page that is no longer in the list.
          next.delete("page");
          return next;
        },
        { replace: true },
      );
    }, 200);
    return () => clearTimeout(timer);
    // `setParams` is stable; `draft` is the only real input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  // `/` focuses search from anywhere on the page, the way every search-first
  // surface behaves — but never while the user is already typing somewhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (event.key === "/" && !typing) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const topics = useHelpTopics();
  const search = useHelpSearch(query);

  const results = query ? (search.data?.results ?? []) : [];
  const fromResults = results.find((r) => r.slug === selectedSlug);

  /**
   * A deep link can name a page that did not rank for its own query — the
   * failed-review panel sends the error text as `q`, and the page that
   * explains it is not always the top match. Falling back to `results[0]`
   * there would show a different answer under the right URL, so the named
   * page is fetched directly instead.
   */
  const direct = useHelpPage(selectedSlug, !!selectedSlug && !fromResults);
  const selected: HelpPassage | undefined =
    fromResults ?? direct.data ?? results[0];

  const select = (slug: string) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("page", slug);
      return next;
    });

  const askCommon = (topic: HelpTopic) => {
    setDraft(topic.title);
    inputRef.current?.focus();
  };

  const searching = query.length > 0;
  const nothingMatched = searching && !search.isPending && results.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <SearchBox
        ref={inputRef}
        value={draft}
        onChange={setDraft}
        busy={search.isFetching}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        {/* On narrow screens this collapses to drill-in: the list, then the
            passage with a Back control. Two panes below ~1024px squeezes both
            into uselessness. */}
        <div className={selected && searching ? "hidden lg:block" : undefined}>
          <ListPane
            searching={searching}
            loading={search.isPending && searching}
            results={results}
            selectedSlug={selected?.slug}
            onSelect={select}
            common={topics.data?.common ?? []}
            allTopics={topics.data?.all_topics ?? []}
            onAsk={askCommon}
          />
        </div>

        <div className={!selected && searching ? "hidden lg:block" : undefined}>
          {nothingMatched ? (
            <NothingMatched query={query} />
          ) : selected ? (
            <ReadingPane
              passage={selected}
              onSelect={select}
              onBack={() =>
                setParams((prev) => {
                  const next = new URLSearchParams(prev);
                  next.delete("page");
                  return next;
                })
              }
            />
          ) : (
            <HowThisWorks />
          )}
        </div>
      </div>

      <ReportProblem query={query} />
    </div>
  );
}

const SearchBox = ({
  ref,
  value,
  onChange,
  busy,
}: {
  ref: React.RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (v: string) => void;
  busy: boolean;
}) => (
  <Sheet>
    <Sheet.Body className="flex flex-col gap-2 py-4">
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className="text-lg text-ink-sub">
          ⌕
        </span>
        <input
          ref={ref}
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Search Liffy's docs"
          aria-label="Search Liffy's documentation"
          className="w-full bg-transparent text-base text-ink outline-none placeholder:text-ink-sub"
        />
        {busy && <Spinner size="sm" label="Searching" />}
      </div>
      {/* Not decoration. The reason an answer here can be trusted is that
          nothing generated it, and this is where that is said. */}
      <p className="text-xs text-ink-sub">
        Searches Liffy's documentation. Not an AI — it returns written answers.
        Press <kbd className="font-mono">/</kbd> to jump here.
      </p>
    </Sheet.Body>
  </Sheet>
);

function ListPane({
  searching,
  loading,
  results,
  selectedSlug,
  onSelect,
  common,
  allTopics,
  onAsk,
}: {
  searching: boolean;
  loading: boolean;
  results: HelpPassage[];
  selectedSlug?: string;
  onSelect: (slug: string) => void;
  common: HelpTopic[];
  allTopics: HelpTopic[];
  onAsk: (topic: HelpTopic) => void;
}) {
  if (searching) {
    return (
      <Sheet>
        <Sheet.Header title={loading ? "Searching" : `${results.length} match${results.length === 1 ? "" : "es"}`} />
        <Sheet.Body className="p-0">
          <ul>
            {results.map((result) => (
              <li key={result.slug}>
                <button
                  type="button"
                  onClick={() => onSelect(result.slug)}
                  aria-current={result.slug === selectedSlug}
                  className={[
                    "w-full border-b border-rule px-4 py-3 text-left transition-colors",
                    "hover:bg-recessed focus-visible:bg-recessed focus-visible:outline-none",
                    result.slug === selectedSlug ? "bg-recessed" : "",
                  ].join(" ")}
                >
                  <span className="block text-sm text-ink">{result.title}</span>
                  <span className="mt-0.5 block text-xs leading-snug text-ink-sub">
                    {result.snippet}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Sheet.Body>
      </Sheet>
    );
  }

  return (
    <Sheet>
      <Sheet.Header title="Common questions" />
      <Sheet.Body className="p-0">
        <ul>
          {common.map((topic) => (
            <li key={topic.slug}>
              <button
                type="button"
                onClick={() => onAsk(topic)}
                className="flex w-full items-baseline gap-2 border-b border-rule px-4 py-3 text-left text-sm text-ink transition-colors hover:bg-recessed focus-visible:bg-recessed focus-visible:outline-none"
              >
                <span aria-hidden="true" className="text-ink-sub">
                  →
                </span>
                {topic.title}
              </button>
            </li>
          ))}
        </ul>
        {allTopics.length > common.length && (
          <details className="px-4 py-3">
            <summary className="cursor-pointer text-xs text-ink-dim">
              Everything else ({allTopics.length - common.length})
            </summary>
            <ul className="mt-2 flex flex-col gap-1">
              {allTopics
                .filter((t) => !common.some((c) => c.slug === t.slug))
                .map((topic) => (
                  <li key={topic.slug}>
                    <button
                      type="button"
                      onClick={() => onAsk(topic)}
                      className="text-left text-xs text-ink-dim hover:text-ink"
                    >
                      {topic.title}
                    </button>
                  </li>
                ))}
            </ul>
          </details>
        )}
      </Sheet.Body>
    </Sheet>
  );
}

function ReadingPane({
  passage,
  onSelect,
  onBack,
}: {
  passage: HelpPassage;
  onSelect: (slug: string) => void;
  onBack: () => void;
}) {
  return (
    <Sheet>
      <Sheet.Header
        title={passage.title}
        actions={
          <Button size="sm" variant="ghost" className="lg:hidden" onClick={onBack}>
            ← Back
          </Button>
        }
      />
      {/* A named region, and announced. On a wide screen this pane changes
          without the focused element moving, so a keyboard user moving down
          the list gets no signal that the answer beside it changed; `polite`
          supplies one. The role makes it a landmark they can jump straight to
          rather than tabbing through every result first. */}
      <Sheet.Body
        role="region"
        aria-label="Answer"
        aria-live="polite"
        className="flex flex-col gap-5"
      >
        {passage.figure && <Figure name={passage.figure} />}
        <Prose markdown={passage.body} />
        {passage.related.length > 0 && (
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-rule pt-4 text-sm">
            <span className="text-ink-sub">Related</span>
            {passage.related.map((link) => (
              <button
                key={link.slug}
                type="button"
                onClick={() => onSelect(link.slug)}
                className="text-ink-dim underline decoration-rule underline-offset-4 hover:text-ink"
              >
                {link.title}
              </button>
            ))}
          </div>
        )}
        <p className="text-xs text-ink-sub">app/help/{passage.slug}.md</p>
      </Sheet.Body>
    </Sheet>
  );
}

function HowThisWorks() {
  return (
    <Sheet>
      <Sheet.Header title="How this works" />
      <Sheet.Body className="flex flex-col gap-4 text-base leading-relaxed text-ink-dim">
        <p className="max-w-prose">
          This searches pages someone wrote by hand. It matches words, not
          meaning, and it never invents an answer — if nothing matches well
          enough it says so rather than showing you its best guess.
        </p>
        <p className="max-w-prose">
          Typos are forgiven. Pick a question on the left, or describe the
          problem in your own words.
        </p>
      </Sheet.Body>
    </Sheet>
  );
}

function NothingMatched({ query }: { query: string }) {
  /**
   * The floor firing is a feature, so this has to look deliberate rather than
   * broken. It is the one screen that proves the search is not bluffing.
   */
  const suggestion = useMemo(
    () => (query.split(/\s+/).length > 6 ? "Try fewer, more specific words." : null),
    [query],
  );

  return (
    <Sheet>
      <Sheet.Header title="Nothing matched" />
      <Sheet.Body className="flex flex-col gap-3 text-base leading-relaxed text-ink-dim">
        <p className="max-w-prose">
          Liffy's docs don't cover “{query}”. That is the honest answer rather
          than the closest page — showing you a near-miss here would be a guess
          dressed as an answer.
        </p>
        {suggestion && <p className="max-w-prose">{suggestion}</p>}
        <p className="max-w-prose text-sm">
          The full documentation lives in the repository under{" "}
          <code className="rounded border border-rule bg-recessed px-1 py-px">
            docs/
          </code>
          . If this is a bug rather than a question, report it below.
        </p>
      </Sheet.Body>
    </Sheet>
  );
}
