import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Sheet } from "@/components/ui/Sheet";
import { useTheme } from "@/hooks/useTheme";
import { contrastRatio, resolveColor } from "@/lib/colors";
import {
  buildCustomTheme,
  DEFAULT_SEEDS,
  resolveCustom,
  TOKENS,
  type ThemeSeeds,
  type TokenName,
} from "@/lib/theme/derive";
import { THEMES, themesByPolarity, type Polarity } from "@/lib/themes";
import { cn } from "@/lib/utils";

/**
 * Choosing a theme, and building one.
 *
 * Saves the moment you press something — no dirty state and no Save button,
 * unlike everything else on this page. That is deliberate and labelled: the
 * rest of Settings is global server configuration behind an explicit PATCH,
 * and this is a preference stored in your browser. Sharing the page's
 * save model would imply it is shared with your team.
 */
export function Appearance() {
  const { theme, prefs, setTheme, saveCustom, clearCustom, matchSystem } =
    useTheme();
  const [editing, setEditing] = useState(false);

  return (
    <Sheet aria-label="Appearance">
      <Sheet.Header
        title="Appearance"
        actions={
          <span className="label text-ink-dim">Stored in this browser</span>
        }
      />

      <Sheet.Body className="flex flex-col gap-5">
        {(["light", "dark"] as Polarity[]).map((polarity) => (
          <div key={polarity} className="flex flex-col gap-2">
            <p className="label">{polarity}</p>
            <div className="flex flex-wrap gap-2">
              {themesByPolarity(polarity).map((spec) => (
                <ThemeChip
                  key={spec.id}
                  id={spec.id}
                  label={spec.label}
                  note={spec.note}
                  selected={theme === spec.id}
                  onSelect={() => setTheme(spec.id)}
                />
              ))}
              {prefs.custom?.seeds.polarity === polarity && (
                <ThemeChip
                  id="custom"
                  label="Custom"
                  note="Yours"
                  selected={theme === "custom"}
                  onSelect={() => setTheme("custom")}
                />
              )}
            </div>
          </div>
        ))}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={prefs.mode === "system" ? "primary" : "secondary"}
            aria-pressed={prefs.mode === "system"}
            onClick={matchSystem}
          >
            Match system
          </Button>
          <span className="text-sm text-ink-dim">
            {/* The two sides are remembered separately, so this is not "light
                or dark" — it is the two themes already chosen. */}
            Uses {themeLabel(prefs.light)} and {themeLabel(prefs.dark)}.
          </span>
        </div>
      </Sheet.Body>

      <Sheet.Header
        title="Custom theme"
        className="border-t border-rule"
        actions={
          <div className="flex items-center gap-2">
            {prefs.custom && (
              <Button size="sm" variant="ghost" onClick={clearCustom}>
                Delete
              </Button>
            )}
            <Button size="sm" onClick={() => setEditing((open) => !open)}>
              {editing ? "Close" : prefs.custom ? "Edit" : "Create"}
            </Button>
          </div>
        }
      />

      {editing && (
        <Sheet.Body>
          <CustomEditor
            initial={prefs.custom?.seeds}
            initialOverrides={prefs.custom?.overrides ?? {}}
            onSave={(seeds, overrides) =>
              saveCustom(buildCustomTheme(seeds, overrides))
            }
          />
        </Sheet.Body>
      )}
    </Sheet>
  );
}

function themeLabel(id: string): string {
  return THEMES.find((spec) => spec.id === id)?.label ?? "Custom";
}

function ThemeChip({
  id,
  label,
  note,
  selected,
  onSelect,
}: {
  id: string;
  label: string;
  note: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      title={note}
      className={cn(
        "rounded-sheet flex items-center gap-2 border px-3 py-2 text-left",
        selected
          ? "border-ink bg-neutral-tint text-ink"
          : "border-rule text-ink-dim hover:border-rule-strong hover:text-ink",
      )}
    >
      {/* A real swatch of the theme, drawn by scoping a probe to it — the
          same trick Monaco and the style guide use, so the chip cannot show
          a colour the theme does not actually have. */}
      <Swatch theme={id} />
      <span className="flex flex-col">
        <span className="text-base">{label}</span>
        <span className="text-2xs text-ink-sub">{note}</span>
      </span>
    </button>
  );
}

function Swatch({ theme }: { theme: string }) {
  return (
    <span
      data-theme={theme}
      aria-hidden="true"
      className="rounded-chip flex size-6 shrink-0 items-center justify-center border border-rule bg-paper"
    >
      <span className="size-2.5 rounded-full bg-ink" />
    </span>
  );
}

const SEED_FIELDS: { key: keyof ThemeSeeds; label: string; hint: string }[] = [
  { key: "surface", label: "Surface", hint: "The page. Everything else derives from it." },
  { key: "ink", label: "Ink", hint: "Primary text." },
  { key: "oxide", label: "Critical", hint: "Failures and request-changes." },
  { key: "sage", label: "Approve", hint: "Passes and completed runs." },
  { key: "ochre", label: "Warning", hint: "In progress, and warnings." },
  { key: "payne", label: "Info", hint: "Informational findings." },
];

/**
 * Five seeds, and an Advanced disclosure over all nineteen tokens.
 *
 * The contrast readout is not decoration. A palette that looks good in the
 * swatches and fails at 3:1 on body text is the single most likely thing to
 * come out of an editor like this, so every ink is measured against the
 * surface it will actually sit on, live. It warns rather than blocks — it is
 * the user's tool, and a hard stop on a theme they can see and like would be
 * the wrong call.
 */
function CustomEditor({
  initial,
  initialOverrides,
  onSave,
}: {
  initial?: ThemeSeeds;
  initialOverrides: Partial<Record<TokenName, string>>;
  onSave: (
    seeds: ThemeSeeds,
    overrides: Partial<Record<TokenName, string>>,
  ) => void;
}) {
  const [seeds, setSeeds] = useState<ThemeSeeds>(
    initial ?? DEFAULT_SEEDS.dark,
  );
  const [overrides, setOverrides] =
    useState<Partial<Record<TokenName, string>>>(initialOverrides);
  const [advanced, setAdvanced] = useState(false);
  const probeRef = useRef<HTMLDivElement>(null);

  const tokens = useMemo(
    () => resolveCustom({ seeds, overrides }),
    [seeds, overrides],
  );

  /**
   * Resolved through the browser rather than computed here.
   *
   * The derived values are `color-mix()` expressions, so there is no hex to
   * measure until something has rendered them. A stable probe lets the effect
   * read those values without mutating the DOM during render.
   */
  const [checks, setChecks] = useState<ContrastChecks | null>(null);

  useEffect(() => {
    const probe = probeRef.current;
    if (!probe) return;

    // The probe is mounted in the tree and measured after commit. React can
    // replay a render, but it cannot leave a render-phase append/remove pair
    // unbalanced.
    TOKENS.forEach((token) =>
      probe.style.setProperty(`--${token}`, tokens[token]),
    );
    const hex = (token: TokenName) =>
      resolveColor(`--${token}`, "#000000", undefined, probe);
    const values = Object.fromEntries(
      TOKENS.map((token) => [token, hex(token)]),
    ) as Record<TokenName, string>;

    const against = (fg: TokenName, bg: TokenName, floor: number) => ({
      label: `${fg} on ${bg}`,
      ratio: contrastRatio(values[fg], values[bg]),
      floor,
    });

    setChecks({
      values,
      rows: [
        against("ink", "paper", 7),
        against("ink-dim", "paper", 4.5),
        against("ink-sub", "paper", 4.5),
        against("oxide", "card", 4.5),
        against("sage", "card", 4.5),
        against("ochre", "card", 4.5),
        against("payne", "card", 4.5),
        against("chrome-ink", "chrome", 7),
        // Advisory: a hairline is not text, and WCAG's 3:1 for non-text
        // would turn every divider into an outline. Flagged low, not failed.
        against("rule", "paper", 1.55),
      ],
    });
  }, [tokens]);

  const failing = checks?.rows.filter((row) => row.ratio < row.floor) ?? [];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap gap-2">
        {(["light", "dark"] as Polarity[]).map((polarity) => (
          <Button
            key={polarity}
            size="sm"
            variant={seeds.polarity === polarity ? "primary" : "secondary"}
            aria-pressed={seeds.polarity === polarity}
            onClick={() =>
              // Swapping polarity reseeds from that side's defaults: a dark
              // ink on a dark surface is not a theme anyone wants to hand-fix
              // one field at a time.
              setSeeds(initial?.polarity === polarity ? initial : DEFAULT_SEEDS[polarity])
            }
            className="capitalize"
          >
            {polarity}
          </Button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {SEED_FIELDS.map((field) => (
          <Field key={field.key} label={field.label} hint={field.hint}>
            {(props) => (
              <span className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label={`${field.label} colour`}
                  value={seeds[field.key] as string}
                  onChange={(event) =>
                    setSeeds({ ...seeds, [field.key]: event.target.value })
                  }
                  className="size-8 shrink-0 cursor-pointer rounded-chip border border-rule bg-card"
                />
                <Input
                  {...props}
                  value={seeds[field.key] as string}
                  onChange={(event) =>
                    setSeeds({ ...seeds, [field.key]: event.target.value })
                  }
                  className="w-28 font-code"
                />
              </span>
            )}
          </Field>
        ))}
      </div>

      <Field
        label="Rule strength"
        hint="How far the hairlines sit from the surface. Everything else follows."
      >
        {(props) => (
          <input
            {...props}
            type="range"
            min={0}
            max={100}
            value={seeds.ruleStrength}
            onChange={(event) =>
              setSeeds({ ...seeds, ruleStrength: Number(event.target.value) })
            }
            className="w-full accent-ink"
          />
        )}
      </Field>

      {/* Live, against the surface each ink will actually sit on. */}
      <div className="flex flex-col gap-2">
        <p className="label">Contrast</p>
        <ul className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
          {checks ? (
            checks.rows.map((row) => (
              <li key={row.label} className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate font-code text-2xs text-ink-dim">
                  {row.label}
                </span>
                <span
                  data-numeric
                  className={row.ratio < row.floor ? "text-oxide" : "text-sage"}
                >
                  {row.ratio.toFixed(2)}
                </span>
              </li>
            ))
          ) : (
            <li className="text-ink-dim">Measuring…</li>
          )}
        </ul>
        {failing.length > 0 && (
          <p className="text-sm text-oxide" role="status">
            {failing.length} combination{failing.length === 1 ? "" : "s"} below
            the readable threshold. You can still save this — it is your tool —
            but text at those ratios is hard to read.
          </p>
        )}
      </div>

      <details
        open={advanced}
        onToggle={(event) => setAdvanced(event.currentTarget.open)}
      >
        <summary className="cursor-pointer text-sm text-ink-dim hover:text-ink">
          Advanced — all {TOKENS.length} tokens
        </summary>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {TOKENS.map((token) => {
            const pinned = overrides[token] !== undefined;
            return (
              <label key={token} className="flex items-center gap-2 text-sm">
                <input
                  type="color"
                  aria-label={token}
                  value={checks?.values[token] ?? "#000000"}
                  onChange={(event) =>
                    setOverrides({ ...overrides, [token]: event.target.value })
                  }
                  className="size-6 shrink-0 cursor-pointer rounded-chip border border-rule"
                />
                <span className="min-w-0 flex-1 truncate font-code text-2xs">
                  {token}
                </span>
                {/* Pinned tokens stop following the seeds, so they say so and
                    offer the way back. Without this a seed change looks
                    broken: most of the palette moves and one swatch does not. */}
                {pinned && (
                  <button
                    type="button"
                    onClick={() => {
                      const next = { ...overrides };
                      delete next[token];
                      setOverrides(next);
                    }}
                    className="shrink-0 text-2xs text-ink-sub underline underline-offset-2 hover:text-ink"
                  >
                    pinned
                  </button>
                )}
              </label>
            );
          })}
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => onSave(seeds, overrides)}>
          Save and use
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setSeeds(DEFAULT_SEEDS[seeds.polarity]);
            setOverrides({});
          }}
        >
          Reset
        </Button>
      </div>

      <div ref={probeRef} aria-hidden="true" className="hidden" />
    </div>
  );
}

type ContrastChecks = {
  values: Record<TokenName, string>;
  rows: { label: string; ratio: number; floor: number }[];
};
