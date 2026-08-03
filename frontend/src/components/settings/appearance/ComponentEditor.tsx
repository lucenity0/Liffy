import { Button } from "@/components/ui/Button";
import { ColorInput, Choice, Slider } from "./controls";
import { SHADOWS, type ComponentOverride, type Shadow } from "@/lib/theme/appearance";
import type { ComponentSpec, Knob } from "@/lib/theme/components";

/**
 * The editor for one component, showing only what that component takes.
 *
 * This is the part that makes Advanced worth having. The old page put every
 * token in one list and left you to work out which of them drew the review
 * header; here you pick the review header and get its seven settings. A knob
 * a component does not accept is not disabled or greyed — it is absent,
 * because the registry says it would do nothing.
 *
 * Values are "unset" until touched, and unset means *follow the theme* rather
 * than "some default this editor made up". That distinction is why every
 * control has a Clear beside it: an override you cannot remove is a theme you
 * can only make more specific.
 */
export function ComponentEditor({
  spec,
  override,
  onChange,
  onClear,
}: {
  spec: ComponentSpec;
  override: ComponentOverride;
  onChange: (next: ComponentOverride) => void;
  onClear: () => void;
}) {
  const set = (patch: Partial<ComponentOverride>) =>
    onChange({ ...override, ...patch });

  const unset = (knob: Knob) => {
    const next = { ...override };
    delete next[knob];
    onChange(next);
  };

  const touched = Object.keys(override).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="label">Editing</p>
          <p className="text-lg text-ink">{spec.label}</p>
          <p className="text-sm text-ink-sub">{spec.note}</p>
        </div>
        {touched > 0 && (
          <Button size="sm" variant="ghost" onClick={onClear}>
            Reset component
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-4">
        {spec.knobs.includes("background") && (
          <KnobRow
            label="Background"
            set={override.background !== undefined}
            onClear={() => unset("background")}
          >
            <ColorInput
              label="Background"
              value={override.background ?? "#000000"}
              onChange={(background) => set({ background })}
            />
          </KnobRow>
        )}

        {spec.knobs.includes("border") && (
          <KnobRow
            label="Border"
            set={override.border !== undefined}
            onClear={() => unset("border")}
          >
            <ColorInput
              label="Border"
              value={override.border ?? "#000000"}
              onChange={(border) => set({ border })}
            />
          </KnobRow>
        )}

        {spec.knobs.includes("ink") && (
          <KnobRow
            label="Text"
            set={override.ink !== undefined}
            onClear={() => unset("ink")}
          >
            <ColorInput
              label="Text"
              value={override.ink ?? "#000000"}
              onChange={(ink) => set({ ink })}
            />
          </KnobRow>
        )}

        {spec.knobs.includes("radius") && (
          <KnobRow
            label="Corner radius"
            set={override.radius !== undefined}
            onClear={() => unset("radius")}
            wide
          >
            <Slider
              label="Corner radius"
              value={override.radius ?? 3}
              min={0}
              max={24}
              step={1}
              format={(value) => `${value}px`}
              onChange={(radius) => set({ radius })}
              hideLabel
            />
          </KnobRow>
        )}

        {spec.knobs.includes("padding") && (
          <KnobRow
            label="Padding"
            set={override.padding !== undefined}
            onClear={() => unset("padding")}
            wide
          >
            <Slider
              label="Padding"
              value={override.padding ?? 10}
              min={0}
              max={32}
              step={1}
              format={(value) => `${value}px`}
              onChange={(padding) => set({ padding })}
              hideLabel
            />
          </KnobRow>
        )}

        {spec.knobs.includes("weight") && (
          <KnobRow
            label="Font weight"
            set={override.weight !== undefined}
            onClear={() => unset("weight")}
          >
            <Choice
              label="Font weight"
              value={override.weight ?? 400}
              onChange={(weight) => set({ weight })}
              options={[
                { value: 400, label: "Regular" },
                { value: 500, label: "Medium" },
                { value: 700, label: "Bold" },
              ]}
            />
          </KnobRow>
        )}

        {spec.knobs.includes("shadow") && (
          <KnobRow
            label="Shadow"
            set={override.shadow !== undefined}
            onClear={() => unset("shadow")}
          >
            <Choice
              label="Shadow"
              value={override.shadow ?? "hard"}
              onChange={(shadow) => set({ shadow: shadow as Shadow })}
              options={SHADOWS.map((id) => ({
                value: id,
                label: id === "hard" ? "Hard" : id === "none" ? "None" : "Elevated",
              }))}
            />
          </KnobRow>
        )}
      </div>
    </div>
  );
}

/**
 * One knob, with its "following the theme" state made visible.
 *
 * Without the badge and the Clear, an override is invisible once set: the
 * control shows a colour either way, and there is no way to tell a value you
 * chose from the theme's own. That is the state the old Advanced disclosure
 * got wrong — a pinned token stopped tracking its seeds with nothing on
 * screen saying so.
 */
function KnobRow({
  label,
  set,
  onClear,
  wide,
  children,
}: {
  label: string;
  set: boolean;
  onClear: () => void;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <p className="label text-ink">{label}</p>
        {set ? (
          <button
            type="button"
            onClick={onClear}
            className="text-2xs text-ink-sub underline underline-offset-2 hover:text-ink"
          >
            overridden — clear
          </button>
        ) : (
          <span className="text-2xs text-ink-sub">follows the theme</span>
        )}
      </div>
      <div className={wide ? undefined : "flex flex-wrap items-center gap-2"}>
        {children}
      </div>
    </div>
  );
}
