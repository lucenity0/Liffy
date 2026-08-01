import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Input, Select } from "@/components/ui/Field";
import type {
  EditableSetting,
  ReadOnlySetting,
  SecretSetting,
  SettingSource,
} from "@/types/api";

/**
 * Where a value came from, said plainly.
 *
 * This marker is the difference between a settings page and a form. "Changed
 * here" versus "set in .env" is the question a newcomer actually has, and
 * answering it is most of why the page is worth building.
 */
const SOURCE_LABEL: Record<SettingSource, string> = {
  default: "Default",
  env: "Set in .env",
  override: "Changed here",
};

function Provenance({
  source,
  defaultValue,
}: {
  source: SettingSource;
  defaultValue: string | number | boolean;
}) {
  return (
    <span className="flex items-center gap-2">
      <Badge tone={source === "override" ? "payne" : "neutral"} variant="tint">
        {SOURCE_LABEL[source]}
      </Badge>
      {/* Only when it differs — repeating the value beside itself is noise. */}
      {source === "override" && (
        <span className="text-sm text-ink-dim">
          default <span className="font-code">{String(defaultValue)}</span>
        </span>
      )}
    </span>
  );
}

function Shell({
  label,
  help,
  control,
  meta,
  htmlFor,
}: {
  label: string;
  help: string;
  control: React.ReactNode;
  meta: React.ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="flex flex-col gap-2 border-b border-rule px-4 py-3 last:border-b-0 sm:flex-row sm:items-start sm:gap-6">
      <div className="min-w-0 flex-1">
        <label htmlFor={htmlFor} className="label text-ink">
          {label}
        </label>
        <p className="mt-1 max-w-prose text-sm text-ink-dim">{help}</p>
        <div className="mt-1.5">{meta}</div>
      </div>
      <div className="shrink-0 sm:w-64">{control}</div>
    </div>
  );
}

/** The sentinel `<option>` that reveals the free-text input. */
const CUSTOM = "__custom__";

/**
 * A dropdown of known-good values that still accepts anything.
 *
 * Model names are the case this exists for. Most people want one of a handful
 * of current models and should not have to remember `claude-haiku-4-5` exactly
 * — but the list cannot be closed, because `openai` also drives Ollama and
 * Gemini, where the valid names are whatever that endpoint happens to serve.
 * So: suggestions in a select, "Custom…" for everything else, and a value that
 * arrived from `.env` outside the list opens in the text field rather than
 * being silently replaced by the first suggestion.
 */
function SuggestedInput({
  id,
  setting,
  value,
  onChange,
  disabled,
  error,
}: {
  id: string;
  setting: EditableSetting;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  error?: string;
}) {
  const known = setting.suggestions.includes(value);
  // Latched, so clearing the box to type a new name does not snap the select
  // back to a suggestion mid-keystroke.
  const [custom, setCustom] = useState(!known);
  const showText = custom || !known;

  return (
    <div className="flex flex-col gap-2">
      <Select
        id={id}
        className="w-full"
        value={showText ? CUSTOM : value}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          if (next === CUSTOM) {
            setCustom(true);
            return;
          }
          setCustom(false);
          onChange(next);
        }}
      >
        {setting.suggestions.map((choice) => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
        <option value={CUSTOM}>Custom…</option>
      </Select>
      {showText && (
        <Input
          className="w-full"
          value={value}
          disabled={disabled}
          aria-label={`${setting.label} (custom)`}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </div>
  );
}

export function EditableSettingRow({
  setting,
  value,
  onChange,
  disabled,
  error,
}: {
  setting: EditableSetting;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  error?: string;
}) {
  const id = `setting-${setting.key}`;

  const control =
    setting.suggestions.length > 0 ? (
      <SuggestedInput
        id={id}
        setting={setting}
        value={value}
        onChange={onChange}
        disabled={disabled}
        error={error}
      />
    ) : setting.kind === "bool" ? (
      <label className="flex items-center gap-2 text-base text-ink">
        <input
          id={id}
          type="checkbox"
          checked={value === "true"}
          disabled={disabled}
          onChange={(event) => onChange(String(event.target.checked))}
          className="size-4 accent-ink disabled:cursor-not-allowed disabled:opacity-60"
        />
        {value === "true" ? "On" : "Off"}
      </label>
    ) : setting.kind === "choice" ? (
      <Select
        id={id}
        className="w-full"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {setting.choices.map((choice) => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
      </Select>
    ) : (
      <Input
        id={id}
        className="w-full"
        inputMode={setting.kind === "int" ? "numeric" : undefined}
        value={value}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
    );

  return (
    <Shell
      htmlFor={id}
      label={setting.label}
      help={setting.help}
      meta={
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Provenance source={setting.source} defaultValue={setting.default_value} />
          {/* On the field, not as a page-level crash — one bad character
              should not take the whole page down. */}
          {error && (
            <span id={`${id}-error`} role="alert" className="text-sm text-oxide">
              {error}
            </span>
          )}
        </div>
      }
      control={control}
    />
  );
}

export function ReadOnlySettingRow({ setting }: { setting: ReadOnlySetting }) {
  const id = `setting-${setting.key}`;
  return (
    <Shell
      htmlFor={id}
      label={setting.label}
      // The reason, not just a disabled box. A field greyed out with no
      // explanation reads as broken rather than as deliberate.
      help={setting.reason}
      meta={<Badge tone="neutral" variant="tint">Restart required</Badge>}
      control={
        <Input
          id={id}
          className="w-full"
          value={String(setting.value)}
          disabled
          readOnly
        />
      }
    />
  );
}

export function SecretSettingRow({
  setting,
  relevant = true,
}: {
  setting: SecretSetting;
  /** False when this credential belongs to a provider that isn't selected. */
  relevant?: boolean;
}) {
  /**
   * "Not configured" is the right answer twice over — for a key nobody needs
   * and for the one the review depends on — so it cannot be the whole answer.
   * The requirement comes from the API and says which of the two this is.
   */
  const help = setting.is_set
    ? "Configured in backend/.env. Its value is never sent to the browser."
    : `${setting.requirement} Set it in backend/.env — see docs/SETUP.md.`;

  return (
    <Shell
      label={setting.label}
      help={relevant ? help : `Not used by the selected provider. ${help}`}
      meta={null}
      control={
        // No input, and no masked value: a mask still discloses the length,
        // and a length is a real hint about a token.
        <Badge
          tone={setting.is_set ? "sage" : relevant ? "ochre" : "neutral"}
          variant="tint"
        >
          {setting.is_set
            ? "Configured"
            : relevant
              ? "Needs configuring"
              : "Not configured"}
        </Badge>
      }
    />
  );
}
