import { useMemo, useState } from "react";
import { Sheet } from "@/components/ui/Sheet";
import { Badge, type BadgeTone, type BadgeVariant } from "@/components/ui/Badge";
import {
  CategoryBadge,
  IndexBadge,
  SeverityBadge,
  StatusBadge,
  VerdictBadge,
} from "@/components/ui/badgeMaps";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton, SkeletonRows } from "@/components/ui/Skeleton";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { Modal } from "@/components/ui/Modal";
import { Field, Input } from "@/components/ui/Field";
import { contrastRatio, resolveColor } from "@/lib/colors";
import { useTheme, type Theme } from "@/hooks/useTheme";
import type {
  Category,
  IndexStatus,
  ReviewStatus,
  Severity,
  Verdict,
} from "@/types/api";

/**
 * DEV-only gallery of every token and primitive, mounted at /_styleguide.
 *
 * This is the review surface for the design system: it needs no data layer,
 * no backend and no fixtures, so the whole visual language can be checked in
 * one screenshot before any screen is built on top of it — and since the
 * graphite palette landed, in one screenshot *per theme*, which is why the
 * mode toggle sits on the page rather than only in the top bar.
 */

const SURFACES = [
  ["--paper", "page"],
  ["--card", "raised leaf"],
  ["--recessed", "headers, footers"],
  ["--rule", "every hairline"],
  ["--rule-strong", "hover, hard shadow"],
] as const;

const INKS = [
  ["--ink", "primary text"],
  ["--ink-dim", "secondary text"],
  ["--ink-sub", "large / non-text only"],
  ["--oxide", "critical · failed"],
  ["--sage", "approve · completed"],
  ["--ochre", "warning · processing"],
  ["--payne", "info · comment"],
] as const;

const TOKENS = [...SURFACES, ...INKS].map(([token]) => token);

/**
 * Hex values and contrast ratios, read back out of the browser on every
 * theme flip rather than written down here.
 *
 * The previous version hardcoded the light-mode hexes and ratios as labels,
 * which was fine while there was one palette and a lie the moment there were
 * two. Resolving them live also means the contrast audit is a standing
 * readout — a value edited in index.css shows its real ratio here
 * immediately, instead of drifting from a comment nobody re-measures.
 */
function usePalette(theme: Theme) {
  // Scoped rather than ambient: asking for the palette *of a theme* makes the
  // memo key a real input instead of a stand-in for "the document changed",
  // and it is the same mechanism the Monaco setup uses to build both themes.
  //
  // Read during render rather than in an effect — by the time `theme` has
  // changed, useTheme has already flipped the class, so an effect would only
  // paint the previous palette's numbers for a frame.
  const scope = theme === "graphite" ? "dark" : "light";
  const hexes = useMemo(
    () =>
      Object.fromEntries(
        TOKENS.map((token) => [token, resolveColor(token, "—", scope)]),
      ),
    [scope],
  );

  const against = (token: string, surface: "--paper" | "--card") => {
    const ink = hexes[token];
    const bg = hexes[surface];
    if (!ink || !bg || ink === "—" || bg === "—") return "—";
    return contrastRatio(ink, bg).toFixed(2);
  };

  return { hex: (token: string) => hexes[token] ?? "—", against };
}

const TYPE_RAMP = [
  ["text-2xs", "10px", "counter chips"],
  ["text-xs", "11px", "the label idiom"],
  ["text-sm", "12.5px", "meta, table secondary"],
  ["text-base", "14px", "body"],
  ["text-md", "15px", "Liffy's prose"],
  ["text-lg", "18px", "section headings"],
  ["text-xl", "22px", "page headings"],
  ["text-2xl", "28px", "display"],
] as const;

const TONES: BadgeTone[] = ["neutral", "oxide", "sage", "ochre", "payne", "ink"];
const VARIANTS: BadgeVariant[] = ["tint", "outline", "solid"];

const STATUSES: ReviewStatus[] = [
  "pending",
  "processing",
  "completed",
  "failed",
];
const VERDICTS: Verdict[] = ["approve", "request_changes", "comment"];
const SEVERITIES: Severity[] = ["critical", "warning", "info"];
const CATEGORIES: Category[] = [
  "logic_error",
  "security",
  "performance",
  "architecture",
  "convention",
  "improvement",
];
const INDEXES: IndexStatus[] = ["indexed", "not_indexed"];

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline gap-3 border-b border-rule pb-2">
        <h2 className="font-hand text-lg leading-tight text-ink">{title}</h2>
        {note && <p className="text-sm text-ink-dim">{note}</p>}
      </div>
      {children}
    </section>
  );
}

function Boom(): React.ReactElement {
  throw new Error("This component throws on purpose.");
}

export function StyleGuide() {
  const [modalOpen, setModalOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [broken, setBroken] = useState(false);
  const [value, setValue] = useState("");
  const { theme, toggle } = useTheme();
  const palette = usePalette(theme);

  return (
    <div className="flex flex-col gap-10 pb-16">
      <header className="flex flex-col gap-2">
        <p className="label">Design system · dev only</p>
        <div className="flex items-center gap-3">
          <h1 className="font-hand text-2xl leading-tight text-ink">
            {theme === "graphite" ? "Liffy in graphite" : "Liffy on paper"}
          </h1>
          <Button className="ml-auto" onClick={toggle}>
            {theme === "graphite" ? "Switch to paper" : "Switch to graphite"}
          </Button>
        </div>
        <p className="max-w-prose text-ink-dim">
          Notebook-style, matte, low-chrome. Monochrome paper carries the
          structure; colour is reserved for things you triage by. Both palettes
          review here — every swatch, badge map and Sheet composition on one
          page, in either mode.
        </p>
      </header>

      <Section title="Surfaces" note="warm paper, never #fff">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {SURFACES.map(([token, role]) => (
            <Sheet key={token}>
              <Sheet.Body className="flex items-center gap-3">
                <span
                  className="size-10 shrink-0 rounded-chip border border-rule"
                  style={{ background: `var(${token})` }}
                />
                <div className="min-w-0">
                  <p className="font-code text-sm text-ink">{token}</p>
                  <p className="font-code text-2xs text-ink-sub">
                    {palette.hex(token)}
                  </p>
                  <p className="text-2xs text-ink-dim">{role}</p>
                </div>
              </Sheet.Body>
            </Sheet>
          ))}
        </div>
      </Section>

      <Section
        title="Inks"
        note="hex and contrast read live — these are the real numbers for the palette on screen"
      >
        <Sheet>
          <Sheet.Header title="Ink" count={INKS.length} />
          <Sheet.List>
            <Sheet.Row className="bg-recessed">
              <span className="size-5 shrink-0" aria-hidden="true" />
              <span className="text-2xs text-ink-sub">token</span>
              <span className="ml-auto flex items-center gap-4">
                <span className="w-16 text-right text-2xs text-ink-sub">
                  hex
                </span>
                <span className="w-12 text-right text-2xs text-ink-sub">
                  :paper
                </span>
                <span className="w-12 text-right text-2xs text-ink-sub">
                  :card
                </span>
                <span className="hidden w-44 text-right text-2xs text-ink-sub sm:inline">
                  role
                </span>
              </span>
            </Sheet.Row>
            {INKS.map(([token, role]) => (
              <Sheet.Row key={token}>
                <span
                  className="size-5 shrink-0 rounded-chip border border-rule"
                  style={{ background: `var(${token})` }}
                />
                <span
                  className="font-code text-sm"
                  style={{ color: `var(${token})` }}
                >
                  The quick brown fox
                </span>
                <span className="ml-auto flex items-center gap-4">
                  <span className="w-16 text-right font-code text-2xs text-ink-sub">
                    {palette.hex(token)}
                  </span>
                  <span
                    data-numeric
                    className="w-12 text-right font-code text-sm text-ink-dim"
                  >
                    {palette.against(token, "--paper")}
                  </span>
                  <span
                    data-numeric
                    className="w-12 text-right font-code text-sm text-ink-dim"
                  >
                    {palette.against(token, "--card")}
                  </span>
                  <span className="hidden w-44 text-right text-2xs text-ink-dim sm:inline">
                    {role}
                  </span>
                </span>
              </Sheet.Row>
            ))}
          </Sheet.List>
        </Sheet>
      </Section>

      <Section title="Type" note="Monaspace — Neon / Argon, identical metrics">
        <div className="grid gap-3 lg:grid-cols-2">
          <Sheet>
            <Sheet.Header title="Neon · UI" />
            <Sheet.Body className="flex flex-col gap-2 font-ui">
              <p className="text-base">lucenity0/Liffy</p>
              <p className="text-sm text-ink-dim">
                indexed · 176 chunks · 2 hours ago
              </p>
              <p className="label">Repositories</p>
            </Sheet.Body>
          </Sheet>
          <Sheet>
            <Sheet.Header title="Argon · code / hand" />
            <Sheet.Body className="flex flex-col gap-2 font-code">
              <p className="text-sm">setup-mac.sh:1-5</p>
              <p className="text-sm">if (x !== null) {"{"} return -&gt; 0 {"}"}</p>
              <p className="text-sm text-ink-dim">
                {"const n = a >= b ? a : b;"}
              </p>
              <p className="prose-hand pt-1">
                This changes the retry loop to back off exponentially, which is
                right — but the jitter is applied after the cap, so the ceiling
                can be exceeded.
              </p>
            </Sheet.Body>
          </Sheet>
        </div>

        <Sheet>
          <Sheet.Header title="Ramp" count={TYPE_RAMP.length} />
          <Sheet.List>
            {TYPE_RAMP.map(([cls, px, role]) => (
              <Sheet.Row key={cls}>
                <span className="w-24 shrink-0 font-code text-2xs text-ink-sub">
                  {cls}
                </span>
                <span className="w-14 shrink-0 font-code text-2xs text-ink-sub">
                  {px}
                </span>
                <span className={`${cls} truncate text-ink`}>
                  Liffy reviewed pull request #58
                </span>
                <span className="ml-auto hidden text-2xs text-ink-dim sm:inline">
                  {role}
                </span>
              </Sheet.Row>
            ))}
          </Sheet.List>
        </Sheet>
      </Section>

      <Section
        title="Badge — the visual vocabulary"
        note="6 tones × 3 variants; domain enums map onto this"
      >
        <Sheet>
          <Sheet.List>
            {TONES.map((tone) => (
              <Sheet.Row key={tone}>
                <span className="w-20 shrink-0 font-code text-2xs text-ink-sub">
                  {tone}
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  {VARIANTS.map((variant) => (
                    <Badge key={variant} tone={tone} variant={variant}>
                      {variant}
                    </Badge>
                  ))}
                  <Badge tone={tone} dot>
                    dot
                  </Badge>
                  <Badge tone={tone} size="md">
                    md
                  </Badge>
                </span>
              </Sheet.Row>
            ))}
          </Sheet.List>
        </Sheet>
      </Section>

      <Section
        title="Badge — the four backend enums"
        note="every value, plus the unknown-value fallback"
      >
        <Sheet>
          <Sheet.List>
            <Sheet.Row>
              <span className="w-24 shrink-0 label">Status</span>
              <span className="flex flex-wrap gap-2">
                {STATUSES.map((v) => (
                  <StatusBadge key={v} value={v} />
                ))}
              </span>
            </Sheet.Row>
            <Sheet.Row>
              <span className="w-24 shrink-0 label">Verdict</span>
              <span className="flex flex-wrap gap-2">
                {VERDICTS.map((v) => (
                  <VerdictBadge key={v} value={v} />
                ))}
              </span>
            </Sheet.Row>
            <Sheet.Row>
              <span className="w-24 shrink-0 label">Severity</span>
              <span className="flex flex-wrap gap-2">
                {SEVERITIES.map((v) => (
                  <SeverityBadge key={v} value={v} />
                ))}
              </span>
            </Sheet.Row>
            <Sheet.Row>
              <span className="w-24 shrink-0 label">Category</span>
              <span className="flex flex-wrap gap-2">
                {CATEGORIES.map((v) => (
                  <CategoryBadge key={v} value={v} />
                ))}
              </span>
            </Sheet.Row>
            <Sheet.Row>
              <span className="w-24 shrink-0 label">Indexing</span>
              <span className="flex flex-wrap gap-2">
                {INDEXES.map((v) => (
                  <IndexBadge key={v} value={v} />
                ))}
              </span>
            </Sheet.Row>
            <Sheet.Row>
              <span className="w-24 shrink-0 label">Unknown</span>
              <span className="flex flex-wrap items-center gap-2">
                <StatusBadge value={"rate_limited" as ReviewStatus} />
                <span className="text-2xs text-ink-dim">
                  the LLM fills these columns, so an off-union value must
                  render, not crash
                </span>
              </span>
            </Sheet.Row>
          </Sheet.List>
        </Sheet>
      </Section>

      <Section title="Buttons" note="bordered boxes; primary inverts to ink">
        <Sheet>
          <Sheet.List>
            {(["primary", "secondary", "ghost", "danger"] as const).map((v) => (
              <Sheet.Row key={v}>
                <span className="w-24 shrink-0 font-code text-2xs text-ink-sub">
                  {v}
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <Button variant={v}>Re-index</Button>
                  <Button variant={v} size="md">
                    Connect repository
                  </Button>
                  <Button variant={v} loading>
                    Working
                  </Button>
                  <Button variant={v} disabled>
                    Disabled
                  </Button>
                </span>
              </Sheet.Row>
            ))}
            <Sheet.Row>
              <span className="w-24 shrink-0 font-code text-2xs text-ink-sub">
                link
              </span>
              <ButtonLink to="/reviews">Go to reviews</ButtonLink>
            </Sheet.Row>
          </Sheet.List>
        </Sheet>
      </Section>

      <Section title="Sheet compositions" note="the one container, four ways">
        <div className="grid gap-3 lg:grid-cols-2">
          <Sheet>
            <Sheet.Header
              title="Repositories"
              count={3}
              actions={<Button variant="primary">Connect</Button>}
            />
            <Sheet.List>
              <Sheet.Row to="/reviews">
                <span className="font-code text-sm">lucenity0/Liffy</span>
                <span className="ml-auto">
                  <IndexBadge value="indexed" />
                </span>
              </Sheet.Row>
              <Sheet.Row to="/reviews">
                <span className="font-code text-sm">lucenity0/portfolio</span>
                <span className="ml-auto">
                  <IndexBadge value="not_indexed" />
                </span>
              </Sheet.Row>
            </Sheet.List>
            <Sheet.Footer>
              <span className="text-sm text-ink-dim">Showing 2 of 3</span>
              <span className="ml-auto flex gap-2">
                <Button disabled>Previous</Button>
                <Button>Next</Button>
              </span>
            </Sheet.Footer>
          </Sheet>

          <div className="flex flex-col gap-3">
            <Sheet>
              <Sheet.Header title="Loading" />
              <SkeletonRows rows={3} />
            </Sheet>
            <Sheet>
              <Sheet.Header title="Empty" />
              <EmptyState
                title="No reviews yet"
                description="Trigger one from a pull request and Liffy will read it."
                action={<Button variant="primary">New review</Button>}
              />
            </Sheet>
            <Sheet tone="recessed">
              <Sheet.Body className="flex items-center gap-3">
                <Spinner />
                <span className="text-sm text-ink-dim">
                  tone="recessed" · Spinner sm
                </span>
                <Spinner size="md" className="ml-auto" />
              </Sheet.Body>
            </Sheet>
          </div>
        </div>
      </Section>

      <Section title="Prose" note="Liffy's voice, on ruled lines">
        <Sheet>
          <Sheet.Header title="Summary" actions={<VerdictBadge value="comment" />} />
          <Sheet.Body>
            <p className="prose-hand">
              Two things worth changing before this merges. The retry helper now
              backs off exponentially, which is the right call, but jitter is
              applied after the cap so the ceiling can still be exceeded under
              load. Separately, the new cache key omits the tenant id — two
              tenants requesting the same document would share an entry.
              Everything else reads cleanly.
            </p>
          </Sheet.Body>
        </Sheet>
      </Section>

      <Section title="Diff washes" note="reusing sage and oxide, not a 2nd palette">
        <Sheet>
          <Sheet.Body padded={false}>
            <pre className="overflow-x-auto py-2 font-code text-sm">
              <div className="px-4 text-ink-sub">@@ -12,7 +12,9 @@</div>
              <div className="px-4 text-ink-dim"> def retry(fn, attempts):</div>
              <div className="bg-diff-del px-4 text-ink">
                -    delay = base * 2 ** n
              </div>
              <div className="bg-diff-add px-4 text-ink">
                +    delay = min(base * 2 ** n, cap)
              </div>
              <div className="bg-diff-add px-4 text-ink">
                +    delay += random() * jitter
              </div>
              <div className="px-4 text-ink-dim"> return fn()</div>
            </pre>
          </Sheet.Body>
        </Sheet>
      </Section>

      <Section title="Form + modal">
        <div className="grid gap-3 lg:grid-cols-2">
          <Sheet>
            <Sheet.Header title="Fields" />
            <Sheet.Body className="flex flex-col gap-4">
              <Field
                label="Repository"
                hint="owner/name, as GitHub spells it"
                required
              >
                {(props) => (
                  <Input
                    {...props}
                    placeholder="lucenity0/Liffy"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                  />
                )}
              </Field>
              <Field
                label="Pull request"
                error="That doesn't look like owner/name"
              >
                {(props) => <Input {...props} defaultValue="not-a-repo" />}
              </Field>
              <Field label="Disabled">
                {(props) => <Input {...props} disabled defaultValue="locked" />}
              </Field>
            </Sheet.Body>
          </Sheet>

          <Sheet>
            <Sheet.Header title="Overlays" />
            <Sheet.Body className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => setModalOpen(true)}>
                Open modal
              </Button>
              <Button
                loading={loading}
                onClick={() => {
                  setLoading(true);
                  setTimeout(() => setLoading(false), 1500);
                }}
              >
                Simulate work
              </Button>
              <Button variant="danger" onClick={() => setBroken(true)}>
                Break a boundary
              </Button>
            </Sheet.Body>
          </Sheet>
        </div>

        <ErrorBoundary key={broken ? "broken" : "ok"}>
          {broken ? <Boom /> : <Skeleton className="h-2 w-full" />}
        </ErrorBoundary>

        <Modal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          title="Connect a repository"
          description="Liffy will index it, then review its pull requests."
          footer={
            <>
              <Button onClick={() => setModalOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={() => setModalOpen(false)}>
                Connect
              </Button>
            </>
          }
        >
          <Field label="Repository" hint="Esc closes. Focus is trapped.">
            {(props) => <Input {...props} placeholder="lucenity0/Liffy" autoFocus />}
          </Field>
        </Modal>
      </Section>
    </div>
  );
}
