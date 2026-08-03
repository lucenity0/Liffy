import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Choice, ColorInput, Row, Slider } from "./controls";
import {
  BODY_WEIGHTS,
  DENSITIES,
  FONTS,
  HEADING_WEIGHTS,
  LINE_HEIGHTS,
  RADIUS_MAX,
  RADIUS_MIN,
  SCALE_MAX,
  SCALE_MIN,
  type AppearanceConfig,
  type Motion,
  type Nav,
  type Shadow,
} from "@/lib/theme/appearance";
import {
  DEFAULT_SEEDS,
  TOKENS,
  type ThemeSeeds,
  type TokenName,
} from "@/lib/theme/derive";
import { themesByPolarity, type Polarity, type ThemeId } from "@/lib/themes";
import { cn } from "@/lib/utils";

/**
 * The four screens, in the order someone actually works through them.
 *
 * Theme first because it is the only one most people will open: a preset and
 * a radius, done. Typography and Layout are the intermediate tier — real
 * choices, none of them colour. Advanced is where the nineteen tokens went,
 * behind a disclosure, next to the component inspector that makes them mostly
 * unnecessary.
 *
 * The old page's failure was presenting all of that at one level, so a
 * personal preference ("a bit bigger") and a surgical override ("chrome-rule
 * on the rail") looked like the same kind of decision.
 */

/* ------------------------------------------------------------------ *
 * 1. Theme
 * ------------------------------------------------------------------ */

export function ThemeSection({
  theme,
  onSelectTheme,
  config,
  update,
  hasCustom,
  onEditCustom,
  systemMode,
  onMatchSystem,
  lightLabel,
  darkLabel,
}: {
  theme: ThemeId;
  onSelectTheme: (id: ThemeId) => void;
  config: AppearanceConfig;
  update: (patch: Partial<AppearanceConfig>) => void;
  hasCustom: boolean;
  onEditCustom: () => void;
  systemMode: boolean;
  onMatchSystem: () => void;
  lightLabel: string;
  darkLabel: string;
}) {
  return (
    <div className="flex flex-col gap-5">
      {/* Presets before pickers. Someone who wants "the dark one" should
          never meet a hex field to get it. */}
      {(["light", "dark"] as Polarity[]).map((polarity) => (
        <Row key={polarity} label={polarity}>
          <div className="flex flex-wrap gap-2">
            {themesByPolarity(polarity).map((spec) => (
              <ThemeChip
                key={spec.id}
                id={spec.id}
                label={spec.label}
                note={spec.note}
                selected={theme === spec.id}
                onSelect={() => onSelectTheme(spec.id)}
              />
            ))}
            {hasCustom && (
              <ThemeChip
                id="custom"
                label="Custom"
                note="Yours"
                selected={theme === "custom"}
                onSelect={() => onSelectTheme("custom")}
              />
            )}
          </div>
        </Row>
      ))}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={systemMode ? "primary" : "secondary"}
          aria-pressed={systemMode}
          onClick={onMatchSystem}
        >
          Match system
        </Button>
        <span className="text-sm text-ink-dim">
          Uses {lightLabel} and {darkLabel}.
        </span>
        <Button size="sm" variant="ghost" onClick={onEditCustom}>
          {hasCustom ? "Edit custom palette" : "Build a custom palette"}
        </Button>
      </div>

      <Slider
        label="Corner radius"
        hint="Liffy is drawn near-square on purpose — the slider stops where that stops being true."
        value={config.radius}
        min={RADIUS_MIN}
        max={RADIUS_MAX}
        step={1}
        ends={[`${RADIUS_MIN}px`, `${RADIUS_MAX}px`]}
        format={(value) => `${value}px`}
        onChange={(radius) => update({ radius })}
      />

      <Row
        label="Shadows"
        hint="Hard offsets, no blur. Paper does not glow; elevation is the same mark further from the page."
      >
        <Choice<Shadow>
          label="Shadows"
          value={config.shadow}
          onChange={(shadow) => update({ shadow })}
          options={[
            { value: "none", label: "None", note: "Flat" },
            { value: "hard", label: "Soft", note: "1px offset" },
            { value: "elevated", label: "Elevated", note: "3px offset" },
          ]}
        />
      </Row>
    </div>
  );
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
      {/* A real swatch of the theme, drawn by scoping a probe to it, so the
          chip cannot show a colour the theme does not actually have. */}
      <span
        data-theme={id}
        aria-hidden="true"
        className="rounded-chip flex size-6 shrink-0 items-center justify-center border border-rule bg-paper"
      >
        <span className="size-2.5 rounded-full bg-ink" />
      </span>
      <span className="flex flex-col">
        <span className="text-base">{label}</span>
        <span className="text-2xs text-ink-sub">{note}</span>
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * 2. Typography
 * ------------------------------------------------------------------ */

export function TypographySection({
  config,
  update,
}: {
  config: AppearanceConfig;
  update: (patch: Partial<AppearanceConfig>) => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <Slider
        label="UI scale"
        hint="One control for the whole interface. Headings, body text, buttons, padding and control heights all move together — there are no individual font-size fields to hunt through."
        value={config.scale}
        min={SCALE_MIN}
        max={SCALE_MAX}
        step={0.05}
        ends={["80%", "120%"]}
        format={(value) => `${Math.round(value * 100)}%`}
        onChange={(scale) => update({ scale })}
      />

      <Row
        label="Interface font"
        hint="Both Monaspace faces ship with Liffy and are preloaded. The system stacks cost nothing to load but are not metric-matched, so the layout shifts a little."
      >
        <Choice
          label="Interface font"
          columns
          value={config.fontUi}
          onChange={(fontUi) => update({ fontUi })}
          options={FONTS.map((font) => ({
            value: font.id,
            label: font.label,
            note: font.note,
          }))}
        />
      </Row>

      <Row label="Review prose font" hint="What Liffy's own writing is set in.">
        <Choice
          label="Review prose font"
          columns
          value={config.fontProse}
          onChange={(fontProse) => update({ fontProse })}
          options={FONTS.map((font) => ({ value: font.id, label: font.label }))}
        />
      </Row>

      <Row label="Code font" hint="Diffs, identifiers and every hex on this page.">
        <Choice
          label="Code font"
          columns
          value={config.fontCode}
          onChange={(fontCode) => update({ fontCode })}
          options={FONTS.map((font) => ({ value: font.id, label: font.label }))}
        />
      </Row>

      <Row label="Heading weight">
        <Choice
          label="Heading weight"
          value={config.headingWeight}
          onChange={(headingWeight) => update({ headingWeight })}
          options={HEADING_WEIGHTS.map((w) => ({ value: w.value, label: w.label }))}
        />
      </Row>

      <Row label="Body weight">
        <Choice
          label="Body weight"
          value={config.bodyWeight}
          onChange={(bodyWeight) => update({ bodyWeight })}
          options={BODY_WEIGHTS.map((w) => ({ value: w.value, label: w.label }))}
        />
      </Row>

      <Row label="Line height">
        <Choice
          label="Line height"
          value={config.leading}
          onChange={(leading) => update({ leading })}
          options={LINE_HEIGHTS.map((l) => ({
            value: l.value,
            label: l.label,
            note: String(l.value),
          }))}
        />
      </Row>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 3. Layout
 * ------------------------------------------------------------------ */

export function LayoutSection({
  config,
  update,
}: {
  config: AppearanceConfig;
  update: (patch: Partial<AppearanceConfig>) => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <Row label="Navigation">
        <Choice<Nav>
          label="Navigation"
          value={config.nav}
          onChange={(nav) => update({ nav })}
          // Not "icons only": Liffy's nav rows are words, so compact means a
          // tighter measure and smaller type. An icons-only rail here would
          // be five unlabelled squares.
          options={[
            { value: "rail", label: "Sidebar", note: "Full width" },
            { value: "compact", label: "Compact", note: "Narrower rail" },
          ]}
        />
      </Row>

      <Row
        label="Density"
        hint="Rides the same spacing scale as UI scale, at a narrower range — so Compact at 120% is still a larger interface than Comfortable at 90%."
      >
        <Choice
          label="Density"
          value={config.density}
          onChange={(density) => update({ density })}
          options={DENSITIES.map((d) => ({ value: d.value, label: d.label }))}
        />
      </Row>

      <Row
        label="Animations"
        hint="If your system asks for reduced motion, Liffy honours that regardless of what is set here."
      >
        <Choice<Motion>
          label="Animations"
          value={config.motion}
          onChange={(motion) => update({ motion })}
          options={[
            { value: "full", label: "Full" },
            { value: "reduced", label: "Reduced", note: "Faster, no easing" },
            { value: "off", label: "Off" },
          ]}
        />
      </Row>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 4. Advanced — the palette editor's seeds and tokens
 * ------------------------------------------------------------------ */

const SEED_FIELDS: { key: keyof ThemeSeeds; label: string; hint: string }[] = [
  { key: "surface", label: "Surface", hint: "The page. Everything else derives from it." },
  { key: "ink", label: "Ink", hint: "Primary text." },
  { key: "oxide", label: "Critical", hint: "Failures and request-changes." },
  { key: "sage", label: "Approve", hint: "Passes and completed runs." },
  { key: "ochre", label: "Warning", hint: "In progress, and warnings." },
  { key: "payne", label: "Info", hint: "Informational findings." },
];

/**
 * Six seeds, then all nineteen tokens behind a disclosure.
 *
 * Unchanged in substance from the editor this page used to open with — the
 * change is that it is no longer the *first* thing anyone sees. A colour
 * picker per token is the right tool for someone who knows which token they
 * want, and the wrong front door for everyone else.
 */
export function PaletteEditor({
  seeds,
  overrides,
  resolved,
  onSeeds,
  onOverrides,
  checks,
}: {
  seeds: ThemeSeeds;
  overrides: Partial<Record<TokenName, string>>;
  resolved: Record<TokenName, string> | null;
  onSeeds: (seeds: ThemeSeeds) => void;
  onOverrides: (overrides: Partial<Record<TokenName, string>>) => void;
  checks: { label: string; ratio: number; floor: number }[] | null;
}) {
  const [advanced, setAdvanced] = useState(false);
  const failing = checks?.filter((row) => row.ratio < row.floor) ?? [];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap gap-2">
        {(["light", "dark"] as Polarity[]).map((polarity) => (
          <Button
            key={polarity}
            size="sm"
            variant={seeds.polarity === polarity ? "primary" : "secondary"}
            aria-pressed={seeds.polarity === polarity}
            // Swapping polarity reseeds from that side's defaults: a dark ink
            // on a dark surface is not a theme anyone wants to hand-fix one
            // field at a time.
            onClick={() => onSeeds(DEFAULT_SEEDS[polarity])}
            className="capitalize"
          >
            {polarity}
          </Button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {SEED_FIELDS.map((field) => (
          <Row key={field.key} label={field.label} hint={field.hint}>
            <ColorInput
              label={field.label}
              value={seeds[field.key] as string}
              onChange={(value) => onSeeds({ ...seeds, [field.key]: value })}
            />
          </Row>
        ))}
      </div>

      <Slider
        label="Rule strength"
        hint="How far the hairlines sit from the surface. Everything else follows."
        value={seeds.ruleStrength}
        min={0}
        max={100}
        step={1}
        format={(value) => `${value}`}
        onChange={(ruleStrength) => onSeeds({ ...seeds, ruleStrength })}
      />

      {/* Live, against the surface each ink will actually sit on. A palette
          that looks good in the swatches and fails at 3:1 on body text is the
          single most likely thing to come out of an editor like this. */}
      <Row label="Contrast">
        <ul className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
          {checks ? (
            checks.map((row) => (
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
      </Row>

      {failing.length > 0 && (
        <p className="text-sm text-oxide" role="status">
          {failing.length} combination{failing.length === 1 ? "" : "s"} below the
          readable threshold. You can still save this — it is your tool — but
          text at those ratios is hard to read.
        </p>
      )}

      <details
        open={advanced}
        onToggle={(event) => setAdvanced(event.currentTarget.open)}
      >
        <summary className="cursor-pointer text-sm text-ink-dim hover:text-ink">
          All {TOKENS.length} tokens
        </summary>
        <p className="mt-2 text-sm text-ink-sub">
          Most themes never need this. If you are here to change one specific
          thing, ⌘K finds it by name instead.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {TOKENS.map((token) => {
            const pinned = overrides[token] !== undefined;
            return (
              <label key={token} className="flex items-center gap-2 text-sm">
                <input
                  type="color"
                  aria-label={token}
                  value={resolved?.[token] ?? "#000000"}
                  onChange={(event) =>
                    onOverrides({ ...overrides, [token]: event.target.value })
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
                      onOverrides(next);
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
    </div>
  );
}
