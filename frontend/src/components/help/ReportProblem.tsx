import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Field } from "@/components/ui/Field";
import { Sheet } from "@/components/ui/Sheet";
import { useSubmitReport } from "@/hooks/useHelp";
import { normalizeApiError } from "@/lib/errors";

/**
 * `normalizeApiError`'s shared copy is written around the repo and trigger
 * endpoints — its 422 branch says "That doesn't look like owner/name.", which
 * is nonsense on this form. Phrase the two failures this endpoint actually
 * produces, and fall back to the server's own detail for anything else.
 */
function reportError(error: unknown): string {
  const normalized = normalizeApiError(error);
  if (normalized.status === 422) {
    return "A title of at least 3 characters and a description of at least 10 are needed.";
  }
  if (normalized.status === 502) {
    return `GitHub refused the issue. ${normalized.message}`;
  }
  return normalized.message;
}

/**
 * The last rung of the ladder: search didn't answer it, so report it.
 *
 * **Security reports do not become public issues.** `SECURITY.md` is explicit
 * that a public issue is readable by everyone, including whoever would use the
 * bug, before there is a fix. So the form asks what kind of report this is
 * first, and a security answer routes to GitHub's private advisory form — with
 * the description deliberately left behind rather than carried into a URL that
 * would put it in browser history and a referrer. The API has no shape for a
 * security report at all, so this branch is the courtesy; that is the fence.
 *
 * **Everything else Liffy files itself**, with the instance's own GitHub token.
 * That attributes the issue to whoever owns that token rather than to the
 * person typing — on a self-hosted install those are usually the same person,
 * and where they are not, the body records who actually wrote it. The earlier
 * design opened a prefilled GitHub URL instead, which kept attribution exact
 * but asked someone who had just failed to find an answer to go and fill in a
 * second form somewhere else.
 */

const REPO = "lucenity0/Liffy";

// `ReportIn.body` is `max_length=8000`. `maxLength` on the textarea constrains
// *typing* and not a value React sets, so an oversized prefill sails through to
// a 422 — which `reportError` renders as "a description of at least 10 are
// needed", telling the reporter their log is too short. Cut well under the
// limit so the reporter's own words still fit alongside it.
const MAX_PREFILL_CHARS = 6000;

/**
 * Prepare provider output for a report body: bounded, and inert as markdown.
 *
 * **Fenced, and that is the load-bearing part.** `api/help.py` posts this body
 * verbatim into a public issue on the Liffy repository, under the instance's
 * own token — and a GitHub issue body is a markdown renderer. `failure_detail`
 * is provider output about a diff written by whoever opened the pull request,
 * so an unfenced prefill is a path from an attacker-authored diff to rendered
 * markdown on this repo: a beaconing image, a misleading link. That is the same
 * hole `defang_model_markdown` closes on the review-posting path, and it must
 * not be reopened through the report form.
 *
 * The fence is sized to the content the way `review_publisher._fence` does it,
 * because a payload containing ``` would otherwise close the block early and
 * put the rest back into markdown — which is precisely what somebody trying
 * this would write.
 */
function seedBody(detail?: string): string {
  if (!detail) return "";

  let text = detail;
  let note = "";
  if (text.length > MAX_PREFILL_CHARS) {
    text = text.slice(0, MAX_PREFILL_CHARS);
    note = `\n… truncated at ${MAX_PREFILL_CHARS} characters; the full log is on the review page.`;
  }

  const longestRun = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((run) => run.length),
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));

  return `\n\n${fence}\n${text}${note}\n${fence}\n`;
}
const ADVISORY_URL = `https://github.com/${REPO}/security/advisories/new`;

type Kind = "bug" | "feature" | "security";

const COPY = {
  bug: {
    titleHint: "One line. What is broken?",
    titlePlaceholder: "Reviews stay queued and never start",
    bodyLabel: "What went wrong?",
    bodyHint: "What you expected, and what happened instead.",
    submit: "File this issue",
  },
  feature: {
    titleHint: "One line. What would you like?",
    titlePlaceholder: "Filter reviews by repository",
    bodyLabel: "What changes would you like?",
    bodyHint:
      "Start from the problem rather than the solution — what were you trying to do, and how does Liffy get in the way?",
    submit: "Send this suggestion",
  },
} as const;

export function ReportProblem({
  query,
  prefillTitle,
  prefillBody,
}: {
  query: string;
  /**
   * A title handed over by whoever linked here — a failed review, today.
   *
   * Opens the form and fills the title, because arriving from "Report this" on
   * a review that just failed and landing on a collapsed form is the same dead
   * end that link existed to remove. Initial state only: it seeds the field
   * and then the field is the user's, so typing over it is not undone by a
   * re-render.
   */
  prefillTitle?: string;
  /**
   * Body text handed over by whoever linked here — the provider output from a
   * failed review, today.
   *
   * The panel that links here says the log goes with the report, and for a
   * `failure_kind: "unknown"` failure that log is the *only* useful thing in
   * it: there is no setting to point at, and the reporter has no way to know
   * which parts matter. Prefilling is what makes that sentence true, rather
   * than rewording it to ask them to paste it themselves.
   *
   * Initial state only, like `prefillTitle` — it seeds the field and then the
   * field is the user's, so editing it is not undone by a re-render.
   *
   * Rendered into a `<textarea>`, so it is text by construction. This is
   * provider output about an attacker-authored diff and must never reach a
   * markdown or HTML renderer.
   */
  prefillBody?: string;
}) {
  const [open, setOpen] = useState(Boolean(prefillTitle || prefillBody));
  const [kind, setKind] = useState<Kind>("bug");
  const [title, setTitle] = useState(prefillTitle ?? "");
  const [body, setBody] = useState(() => seedBody(prefillBody));
  const report = useSubmitReport();

  const reset = () => {
    setTitle("");
    setBody("");
    report.reset();
  };

  if (!open) {
    return (
      <div className="flex justify-center py-2">
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          Still stuck? Report a problem
        </Button>
      </div>
    );
  }

  // Filed. The number is the receipt, and this is the only chance to hand it
  // over — so the form reports where it went rather than snapping shut.
  if (report.isSuccess) {
    return (
      <Sheet>
        <Sheet.Header title="Filed" />
        <Sheet.Body className="flex flex-col gap-3">
          <p className="text-base text-ink">
            Opened as{" "}
            <a
              href={report.data.url}
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-rule underline-offset-4 hover:text-ink"
            >
              {REPO}#{report.data.number}
            </a>
            . Thank you — genuinely.
          </p>
          <p className="max-w-prose text-sm text-ink-dim">
            Follow it there for updates, and add screenshots or detail by
            commenting on the issue.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                reset();
                setOpen(false);
              }}
            >
              Done
            </Button>
            <Button size="sm" variant="ghost" onClick={reset}>
              Report something else
            </Button>
          </div>
        </Sheet.Body>
      </Sheet>
    );
  }

  const copy = kind === "security" ? null : COPY[kind];
  const canSubmit = title.trim().length >= 3 && body.trim().length >= 10;

  return (
    <Sheet>
      <Sheet.Header
        title="Report a problem"
        actions={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              reset();
              setOpen(false);
            }}
          >
            Cancel
          </Button>
        }
      />
      <Sheet.Body className="flex flex-col gap-4">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm text-ink">What kind of report?</legend>
          {(
            [
              ["bug", "A bug, or something confusing"],
              ["feature", "A feature idea, or feedback"],
              ["security", "A security vulnerability"],
            ] as const
          ).map(([value, label]) => (
            <label
              key={value}
              className="flex items-center gap-2 text-sm text-ink-dim"
            >
              <input
                type="radio"
                name="report-kind"
                value={value}
                checked={kind === value}
                onChange={() => {
                  setKind(value);
                  report.reset();
                }}
              />
              {label}
            </label>
          ))}
        </fieldset>

        {kind === "security" ? (
          <div className="flex flex-col gap-3">
            <p className="max-w-prose text-base leading-relaxed text-ink">
              Please don't put it in a public issue.
            </p>
            <p className="max-w-prose text-sm leading-relaxed text-ink-dim">
              A public issue is readable by everyone — including anyone who
              would use the bug — before there is a fix. GitHub's private
              advisory form keeps the report visible only to maintainers, gives
              somewhere to work on a fix with you, and can issue a CVE.
            </p>
            <p className="max-w-prose text-sm leading-relaxed text-ink-dim">
              Describe it there rather than here. Liffy deliberately doesn't
              carry the details, so nothing about the vulnerability ends up in a
              URL, your browser history, or a referrer header.
            </p>
            <div>
              <Button
                variant="primary"
                onClick={() =>
                  window.open(ADVISORY_URL, "_blank", "noopener,noreferrer")
                }
              >
                Open the private advisory form ↗
              </Button>
            </div>
          </div>
        ) : (
          <>
            <Field label="Title" hint={copy!.titleHint}>
              {(props) => (
                <input
                  {...props}
                  type="text"
                  value={title}
                  maxLength={120}
                  placeholder={copy!.titlePlaceholder}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full rounded-chip border border-rule bg-card px-3 py-2 text-sm text-ink placeholder:text-ink-sub"
                />
              )}
            </Field>

            <Field label={copy!.bodyLabel} hint={copy!.bodyHint}>
              {(props) => (
                <textarea
                  {...props}
                  rows={5}
                  value={body}
                  maxLength={8000}
                  onChange={(e) => setBody(e.target.value)}
                  className="w-full rounded-chip border border-rule bg-card px-3 py-2 text-sm text-ink"
                />
              )}
            </Field>

            {report.isError && (
              <ErrorNote error={report.error} message={reportError(report.error)} />
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                disabled={!canSubmit || report.isPending}
                onClick={() =>
                  report.mutate({
                    title: title.trim(),
                    // The failed search, appended rather than mixed in. It is
                    // the single most useful line for triage and nobody thinks
                    // to include it.
                    body: query.trim()
                      ? `${body.trim()}\n\n---\nSearched help for: "${query.trim()}"`
                      : body.trim(),
                    kind,
                  })
                }
              >
                {report.isPending ? "Filing…" : copy!.submit}
              </Button>
              <span className="text-xs text-ink-sub">
                {/* This used to promise that no source code was included, which
                    stopped being true the moment a failed review could prefill
                    its provider output here — that output quotes paths and
                    diff content. Saying "we send what is in the box" is both
                    accurate and more useful: it tells the reporter the one
                    thing they can act on, which is to read it first. */}
                Posts to {REPO} straight away, exactly as written above. No
                tokens or keys are included — check the rest before you send it.
              </span>
            </div>
          </>
        )}
      </Sheet.Body>
    </Sheet>
  );
}
