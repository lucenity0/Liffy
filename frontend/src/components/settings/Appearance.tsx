import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { useAppearance } from "@/hooks/useAppearance";
import { usePaletteShortcut } from "@/hooks/usePaletteShortcut";
import { useTheme } from "@/hooks/useTheme";
import { contrastRatio, resolveColor } from "@/lib/colors";
import { isDefault, type ComponentOverride } from "@/lib/theme/appearance";
import { componentSpec, pruneOverride, type ComponentSpec } from "@/lib/theme/components";
import {
  buildCustomTheme,
  DEFAULT_SEEDS,
  resolveCustom,
  TOKENS,
  type ThemeSeeds,
  type TokenName,
} from "@/lib/theme/derive";
import {
  customFromSaved,
  deleteTheme,
  duplicateTheme,
  importTheme,
  listThemes,
  renameTheme,
  saveTheme,
  type SavedTheme,
} from "@/lib/theme/library";
import { THEMES, type ThemeId } from "@/lib/themes";
import { cn } from "@/lib/utils";
import { ComponentEditor } from "./appearance/ComponentEditor";
import { ComponentPalette } from "./appearance/ComponentPalette";
import { LivePreview, type PreviewSurface } from "./appearance/LivePreview";
import {
  LayoutSection,
  PaletteEditor,
  ThemeSection,
  TypographySection,
} from "./appearance/sections";
import { ThemeLibrary } from "./appearance/ThemeLibrary";

/**
 * Designing your workspace, rather than editing a stylesheet.
 *
 * The page this replaces put a theme picker and nineteen colour inputs on one
 * surface at one level, with no way to see the effect without saving and
 * navigating away, and exactly one slot to keep a result in. Three separate
 * problems, and they compound: you cannot judge a change you cannot see, so
 * you save to look, and saving overwrites the thing you were comparing
 * against.
 *
 * So: four layers in the order people work through them, a preview that is
 * the app's own stylesheet at a smaller size, and a library that makes an
 * experiment recoverable.
 *
 * Everything lands the instant you press it — no dirty state, no Save button.
 * That is unchanged and still deliberate: the rest of Settings is global
 * server configuration behind an explicit PATCH, and this is a preference in
 * your browser. Sharing the page's save model would imply it is shared with
 * your team. What is new is that "undo" now has a real answer — Reset, or any
 * saved theme — instead of meaning "remember what it was".
 */

type SectionId = "theme" | "typography" | "layout" | "advanced";

const SECTIONS: { id: SectionId; label: string; note: string }[] = [
  { id: "theme", label: "Theme", note: "Palette, radius, shadows" },
  { id: "typography", label: "Typography", note: "Scale, faces, weights" },
  { id: "layout", label: "Layout", note: "Navigation, density, motion" },
  { id: "advanced", label: "Advanced", note: "Tokens and components" },
];

export function Appearance() {
  const { theme, prefs, setTheme, saveCustom, clearCustom, matchSystem } =
    useTheme();
  const { config, update, replace, reset } = useAppearance();

  const [section, setSection] = useState<SectionId>("theme");
  const [surface, setSurface] = useState<PreviewSurface>("dashboard");
  const [selected, setSelected] = useState<ComponentSpec | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [themes, setThemes] = useState<SavedTheme[]>(() => listThemes());
  const [activeSavedId, setActiveSavedId] = useState<string | null>(null);

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  usePaletteShortcut(openPalette);

  /* -------------------------------------------------------------- *
   * The custom palette, edited live.
   * -------------------------------------------------------------- */

  const [seeds, setSeeds] = useState<ThemeSeeds>(
    () => prefs.custom?.seeds ?? DEFAULT_SEEDS.dark,
  );
  const [overrides, setOverrides] = useState<Partial<Record<TokenName, string>>>(
    () => prefs.custom?.overrides ?? {},
  );

  const resolved = useMemo(
    () => resolveCustom({ seeds, overrides }),
    [seeds, overrides],
  );

  /**
   * Editing the palette applies it. There is no "Save and use" any more.
   *
   * The button existed because there was nowhere to see the result without
   * committing; now the preview is on screen while you drag, so committing
   * *is* the preview and a second step would only be a step. Switching the
   * document to the custom theme is part of it — a palette editor that leaves
   * you looking at a different theme is the original complaint restated.
   */
  const applyPalette = useCallback(
    (nextSeeds: ThemeSeeds, nextOverrides: Partial<Record<TokenName, string>>) => {
      setSeeds(nextSeeds);
      setOverrides(nextOverrides);
      saveCustom(buildCustomTheme(nextSeeds, nextOverrides));
      setActiveSavedId(null);
    },
    [saveCustom],
  );

  const { checks, probeRef } = useContrastChecks(resolved);

  /* -------------------------------------------------------------- *
   * The library.
   * -------------------------------------------------------------- */

  const applySaved = useCallback(
    (saved: SavedTheme) => {
      const custom = customFromSaved(saved);
      if (custom) {
        setSeeds(custom.seeds);
        setOverrides(custom.overrides);
        saveCustom(custom);
      } else {
        setTheme(saved.base);
      }
      replace(saved.appearance);
      setActiveSavedId(saved.id);
    },
    [replace, saveCustom, setTheme],
  );

  const saveCurrent = useCallback(
    (name: string) => {
      const next = saveTheme(
        {
          name,
          base: theme,
          seeds: theme === "custom" ? seeds : null,
          overrides: theme === "custom" ? overrides : {},
          appearance: config,
        },
        // Passed in rather than read inside library.ts, so saving stays a
        // pure function of its inputs and the tests do not need a clock.
        Date.now(),
      );
      setThemes(next);
      setActiveSavedId(
        next.find((candidate) => candidate.name === name.trim())?.id ?? null,
      );
    },
    [config, overrides, seeds, theme],
  );

  const onImport = useCallback((text: string): string | null => {
    const result = importTheme(text);
    if (!result.ok) return result.error;
    setThemes(saveTheme(result.theme, Date.now()));
    return null;
  }, []);

  /* -------------------------------------------------------------- *
   * Component overrides.
   * -------------------------------------------------------------- */

  const selectComponent = useCallback((spec: ComponentSpec) => {
    setSelected(spec);
    setSection("advanced");
    setSurface(spec.surface);
  }, []);

  const setOverride = useCallback(
    (id: string, override: ComponentOverride) => {
      const pruned = pruneOverride(id, override);
      const components = { ...config.components };
      if (Object.keys(pruned).length) components[id] = pruned;
      else delete components[id];
      update({ components });
      setActiveSavedId(null);
    },
    [config.components, update],
  );

  const overrideCount = Object.keys(config.components).length;
  const untouched = isDefault(config);

  return (
    <div className="flex flex-col gap-4">
      <Sheet aria-label="Appearance">
        <Sheet.Header
          title="Appearance"
          actions={
            <div className="flex items-center gap-2">
              <span className="label text-ink-dim">Stored in this browser</span>
              <Button size="sm" variant="ghost" onClick={openPalette}>
                ⌘K components
              </Button>
              {!untouched && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    reset();
                    setSelected(null);
                    setActiveSavedId(null);
                  }}
                >
                  Reset
                </Button>
              )}
            </div>
          }
        />

        {/* Two panes, and the preview is the point of the split: every control
            on the left changes something on the right without a save, a
            navigation, or a guess. It stacks on narrow screens rather than
            shrinking, because a preview too small to read is worse than one
            you scroll to. */}
        <Sheet.Body className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
          <div className="flex min-w-0 flex-col gap-4">
            <nav
              aria-label="Appearance sections"
              className="flex flex-wrap gap-1"
            >
              {SECTIONS.map((spec) => (
                <button
                  key={spec.id}
                  type="button"
                  aria-current={section === spec.id ? "true" : undefined}
                  onClick={() => setSection(spec.id)}
                  className={cn(
                    "rounded-chip border-l-2 px-2.5 py-1.5 text-left transition-colors duration-100",
                    section === spec.id
                      ? "border-ink bg-neutral-tint text-ink"
                      : "border-transparent text-ink-dim hover:bg-neutral-tint hover:text-ink",
                  )}
                >
                  <span className="block text-base">{spec.label}</span>
                  <span className="block text-2xs text-ink-sub">{spec.note}</span>
                </button>
              ))}
            </nav>

            {section === "theme" && (
              <ThemeSection
                theme={theme}
                onSelectTheme={(id) => {
                  setTheme(id);
                  setActiveSavedId(null);
                }}
                config={config}
                update={update}
                hasCustom={Boolean(prefs.custom)}
                onEditCustom={() => {
                  setSection("advanced");
                  setSelected(null);
                }}
                systemMode={prefs.mode === "system"}
                onMatchSystem={matchSystem}
                lightLabel={themeLabel(prefs.light)}
                darkLabel={themeLabel(prefs.dark)}
              />
            )}

            {section === "typography" && (
              <TypographySection config={config} update={update} />
            )}

            {section === "layout" && (
              <LayoutSection config={config} update={update} />
            )}

            {section === "advanced" && (
              <div className="flex flex-col gap-6">
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="label text-ink">Component overrides</p>
                    <Button size="sm" onClick={openPalette}>
                      Search components — ⌘K
                    </Button>
                  </div>

                  {selected ? (
                    <ComponentEditor
                      spec={selected}
                      override={config.components[selected.id] ?? {}}
                      onChange={(next) => setOverride(selected.id, next)}
                      onClear={() => setOverride(selected.id, {})}
                    />
                  ) : (
                    <p className="text-sm text-ink-sub">
                      Pick a component to edit only that component — its
                      background, border, radius, padding, weight and shadow,
                      and nothing else. It highlights in the preview as soon as
                      you choose it.
                    </p>
                  )}

                  {overrideCount > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-2xs text-ink-sub">Overridden:</span>
                      {Object.keys(config.components).map((id) => {
                        const spec = componentSpec(id);
                        if (!spec) return null;
                        return (
                          <button
                            key={id}
                            type="button"
                            onClick={() => selectComponent(spec)}
                            className="rounded-chip border border-rule px-1.5 py-0.5 text-2xs text-ink-dim hover:border-rule-strong hover:text-ink"
                          >
                            {spec.label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="flex flex-col gap-3 border-t border-rule pt-5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="label text-ink">Custom palette</p>
                    {prefs.custom && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          // clearCustom drops prefs.custom, but the editor's
                          // own seeds/overrides are separate state, seeded
                          // once from prefs.custom and touched only by
                          // applyPalette/applySaved. Left alone, the deleted
                          // palette stayed on screen below and the next seed
                          // nudge called applyPalette → saveCustom, silently
                          // resurrecting it and switching back to "custom".
                          clearCustom();
                          setSeeds(DEFAULT_SEEDS.dark);
                          setOverrides({});
                        }}
                      >
                        Delete palette
                      </Button>
                    )}
                  </div>
                  <PaletteEditor
                    seeds={seeds}
                    overrides={overrides}
                    resolved={checks?.values ?? null}
                    onSeeds={(next) => applyPalette(next, overrides)}
                    onOverrides={(next) => applyPalette(seeds, next)}
                    checks={checks?.rows ?? null}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Sticky, so it stays put while the left pane scrolls — the whole
              value is being able to see the effect of the control under your
              cursor, and a preview that scrolls away has none. */}
          <div className="lg:sticky lg:top-4 lg:self-start">
            <LivePreview
              surface={surface}
              onSurfaceChange={setSurface}
              highlight={section === "advanced" ? selected : null}
            />
          </div>
        </Sheet.Body>
      </Sheet>

      <Sheet aria-label="My themes">
        <Sheet.Header
          title="My themes"
          actions={
            <span className="label text-ink-dim">
              {themes.length} saved · portable
            </span>
          }
        />
        <Sheet.Body>
          <ThemeLibrary
            themes={themes}
            activeId={activeSavedId}
            onApply={applySaved}
            onSaveCurrent={saveCurrent}
            onRename={(id, name) => setThemes(renameTheme(id, name))}
            onDuplicate={(id) => setThemes(duplicateTheme(id, Date.now()))}
            onDelete={(id) => {
              setThemes(deleteTheme(id));
              if (id === activeSavedId) setActiveSavedId(null);
            }}
            onImport={onImport}
          />
        </Sheet.Body>
      </Sheet>

      <ComponentPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onSelect={selectComponent}
      />

      {/* Mounted in the tree and measured after commit — see useContrastChecks.
          Lives here rather than inside PaletteEditor so the readings survive
          switching sections, which is also what keeps a bad-contrast warning
          visible from the Theme tab. */}
      <div ref={probeRef} aria-hidden="true" className="hidden" />
    </div>
  );
}

function themeLabel(id: ThemeId): string {
  return THEMES.find((spec) => spec.id === id)?.label ?? "Custom";
}

type ContrastChecks = {
  values: Record<TokenName, string>;
  rows: { label: string; ratio: number; floor: number }[];
};

/**
 * Contrast, measured through the browser rather than computed here.
 *
 * The derived values are `color-mix()` expressions, so there is no hex to
 * measure until something has rendered them. A stable probe mounted in the
 * tree lets the effect read those values after commit — React can replay a
 * render, but it cannot leave a render-phase append/remove pair unbalanced.
 *
 * It warns rather than blocks. It is the user's tool, and a hard stop on a
 * theme they can see and like would be the wrong call — but a palette that
 * looks good in swatches and fails at 3:1 on body text is the single most
 * likely thing to come out of an editor like this, so every ink is measured
 * against the surface it will actually sit on.
 */
function useContrastChecks(tokens: Record<TokenName, string>) {
  const probeRef = useRef<HTMLDivElement>(null);
  const [checks, setChecks] = useState<ContrastChecks | null>(null);

  useEffect(() => {
    const probe = probeRef.current;
    if (!probe) return;

    TOKENS.forEach((token) =>
      probe.style.setProperty(`--${token}`, tokens[token]),
    );
    const values = Object.fromEntries(
      TOKENS.map((token) => [
        token,
        resolveColor(`--${token}`, "#000000", undefined, probe),
      ]),
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
        // Advisory: a hairline is not text, and WCAG's 3:1 for non-text would
        // turn every divider into an outline. Flagged low, not failed.
        against("rule", "paper", 1.55),
      ],
    });
  }, [tokens]);

  return { checks, probeRef };
}
