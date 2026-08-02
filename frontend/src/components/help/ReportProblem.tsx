import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Sheet } from "@/components/ui/Sheet";
import { useSettings } from "@/hooks/useSettings";

/**
 * The last rung of the ladder: search didn't answer it, so report it.
 *
 * Two things here are not cosmetic.
 *
 * **Security reports do not become public issues.** `SECURITY.md` is explicit
 * that a public issue is readable by everyone, including whoever would use the
 * bug, before there is a fix. So the form asks what kind of report this is
 * *first*, and a security answer routes to GitHub's private advisory form —
 * with the description deliberately left behind rather than carried into a URL
 * that would put it in browser history and a referrer.
 *
 * **Liffy does not file the issue.** It opens GitHub with the text prefilled
 * and the reporter submits it themselves. That keeps attribution with the
 * person who hit the bug, needs no new token scope, and means no deployment of
 * Liffy can post to the repository unattended.
 */

const REPO = "lucenity0/Liffy";
const ADVISORY_URL = `https://github.com/${REPO}/security/advisories/new`;

type Kind = "bug" | "security";

export function ReportProblem({ query }: { query: string }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>("bug");
  const [description, setDescription] = useState("");
  const settings = useSettings();

  /**
   * The diagnostic block, assembled from settings the API already publishes.
   *
   * Only `llm_provider` and the model — both non-secret, both the first thing
   * anyone triaging a Liffy bug asks for. Secrets are not reachable from here
   * even in principle: the settings endpoint reports whether a credential is
   * set and never its value, so there is nothing to leak into a URL.
   */
  const provider =
    settings.data?.editable.find((s) => s.key === "llm_provider")?.value ?? "unknown";
  const context = [
    `- Provider: ${provider}`,
    query ? `- Searched help for: "${query}"` : null,
    `- Reported from: Liffy's in-app help`,
  ]
    .filter(Boolean)
    .join("\n");

  const body = [
    "## What happened",
    "",
    description.trim() || "_(describe what you expected and what happened instead)_",
    "",
    "## Context",
    "",
    context,
    "",
    "<!-- Liffy prefilled the Context section. Edit anything before submitting. -->",
  ].join("\n");

  const issueUrl =
    `https://github.com/${REPO}/issues/new` +
    `?title=${encodeURIComponent(description.trim().slice(0, 80) || "Bug report")}` +
    `&body=${encodeURIComponent(body)}`;

  if (!open) {
    return (
      <div className="flex justify-center py-2">
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          Still stuck? Report a problem
        </Button>
      </div>
    );
  }

  return (
    <Sheet>
      <Sheet.Header
        title="Report a problem"
        actions={
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        }
      />
      <Sheet.Body className="flex flex-col gap-4">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm text-ink">What kind of problem?</legend>
          {(
            [
              ["bug", "A bug, or something confusing"],
              ["security", "A security vulnerability"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex items-center gap-2 text-sm text-ink-dim">
              <input
                type="radio"
                name="report-kind"
                value={value}
                checked={kind === value}
                onChange={() => setKind(value)}
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
              Describe it there rather than here: Liffy deliberately doesn't
              carry the details, so nothing about the vulnerability ends up in
              a URL, your browser history, or a referrer header.
            </p>
            <div>
              <Button
                variant="primary"
                onClick={() => window.open(ADVISORY_URL, "_blank", "noopener,noreferrer")}
              >
                Open the private advisory form ↗
              </Button>
            </div>
          </div>
        ) : (
          <>
            <Field label="What went wrong?" hint="What you expected, and what happened instead.">
              {(props) => (
                <textarea
                  {...props}
                  rows={4}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full rounded border border-rule bg-card px-3 py-2 text-sm text-ink outline-none focus-visible:border-rule-strong"
                />
              )}
            </Field>

            <div className="rounded border border-rule bg-recessed px-3 py-2">
              <p className="mb-1 text-xs text-ink-dim">
                Liffy will attach this — you can edit it on GitHub before
                submitting:
              </p>
              <pre className="overflow-x-auto whitespace-pre-wrap text-xs text-ink-sub">
                {context}
              </pre>
              <p className="mt-1 text-xs text-ink-sub">
                No tokens, keys, or source code are included.
              </p>
            </div>

            <div className="flex items-center gap-3">
              <Button
                variant="primary"
                onClick={() => window.open(issueUrl, "_blank", "noopener,noreferrer")}
              >
                Open a prefilled issue ↗
              </Button>
              {/* Said plainly, because "Open" could reasonably be read as
                  "post". Nothing is filed until they press Submit on GitHub. */}
              <span className="text-xs text-ink-sub">
                Opens GitHub under your own account. Nothing is filed until you
                submit it there.
              </span>
            </div>
          </>
        )}
      </Sheet.Body>
    </Sheet>
  );
}
