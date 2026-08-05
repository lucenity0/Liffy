import { useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import type { SavedTheme } from "@/lib/theme/library";
import { exportTheme } from "@/lib/theme/library";
import { themeSpec } from "@/lib/themes";
import { cn } from "@/lib/utils";

/**
 * My Themes — the answer to "I cannot keep the one I made".
 *
 * The old page had exactly one custom slot, so building a second theme meant
 * destroying the first, and there was no way to try an idea and go back. A
 * saved theme captures both halves of a look at once — the palette and the
 * workspace shape — so applying one restores everything you had, not the
 * colours with someone else's type scale still on top.
 *
 * Export writes a file rather than a link or a code. These are local to your
 * browser by design (Liffy's backend holds one shared server configuration,
 * and a personal palette is not that), so the only honest way to share one is
 * to hand over something you can see and read.
 */
export function ThemeLibrary({
  themes,
  activeId,
  onApply,
  onSaveCurrent,
  onRename,
  onDuplicate,
  onDelete,
  onImport,
}: {
  themes: readonly SavedTheme[];
  /** Which saved theme the current look came from, if any. */
  activeId: string | null;
  onApply: (theme: SavedTheme) => void;
  onSaveCurrent: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onImport: (text: string) => string | null;
}) {
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const save = () => {
    const clean = name.trim();
    if (!clean) return;
    onSaveCurrent(clean);
    setName("");
  };

  return (
    <div className="flex flex-col gap-3">
      {themes.length === 0 && (
        <p className="text-sm text-ink-sub">
          Nothing saved yet. Build a look you like, name it, and it will be
          here — colours, type scale and layout together.
        </p>
      )}

      <ul className="flex flex-col gap-1.5">
        {themes.map((theme) => (
          <li
            key={theme.id}
            className={cn(
              "rounded-sheet flex flex-wrap items-center gap-2 border px-2.5 py-2",
              theme.id === activeId
                ? "border-ink bg-neutral-tint"
                : "border-rule",
            )}
          >
            {renaming === theme.id ? (
              <input
                type="text"
                autoFocus
                value={draftName}
                aria-label={`Rename ${theme.name}`}
                onChange={(event) => setDraftName(event.target.value)}
                onBlur={() => {
                  onRename(theme.id, draftName);
                  setRenaming(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    onRename(theme.id, draftName);
                    setRenaming(null);
                  } else if (event.key === "Escape") {
                    setRenaming(null);
                  }
                }}
                className="min-w-0 flex-1 rounded-chip border border-rule bg-card px-2 py-1 text-sm text-ink"
              />
            ) : (
              <button
                type="button"
                onClick={() => onApply(theme)}
                className="min-w-0 flex-1 text-left"
              >
                <span className="block truncate text-base text-ink">
                  {theme.name}
                </span>
                <span className="block truncate text-2xs text-ink-sub">
                  {theme.base === "custom"
                    ? "Custom palette"
                    : themeSpec(theme.base).label}
                  {" · "}
                  {Math.round(theme.appearance.scale * 100)}% scale
                  {Object.keys(theme.appearance.components).length > 0 &&
                    ` · ${Object.keys(theme.appearance.components).length} overrides`}
                </span>
              </button>
            )}

            <span className="flex shrink-0 items-center gap-1">
              <Button size="sm" variant="ghost" onClick={() => onApply(theme)}>
                Use
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setRenaming(theme.id);
                  setDraftName(theme.name);
                }}
              >
                Rename
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onDuplicate(theme.id)}
              >
                Duplicate
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => download(theme)}
              >
                Export
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onDelete(theme.id)}
              >
                Delete
              </Button>
            </span>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={name}
          placeholder="Name this theme"
          aria-label="Name this theme"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && save()}
          className="min-w-0 flex-1 rounded-chip border border-rule bg-card px-2 py-1.5 text-sm text-ink placeholder:text-ink-sub"
        />
        <Button size="sm" variant="primary" onClick={save} disabled={!name.trim()}>
          Save current
        </Button>
        <Button size="sm" onClick={() => fileRef.current?.click()}>
          Import
        </Button>
        {/* The picker is the whole import UI. A drop zone would be a second
            affordance for one action on a page that already has plenty. */}
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            // Clearing the value is what lets the same file be picked twice
            // after a failed import — otherwise onChange never fires again.
            event.target.value = "";
            if (!file) return;
            setImportError(onImport(await file.text()));
          }}
        />
      </div>

      {/* `error={null}` with explicit copy: nothing here came back from the
          API, so the shared normalizer has nothing to normalize — the reason
          a theme file was rejected is known exactly, by importTheme. */}
      {importError && <ErrorNote error={null} message={importError} />}
    </div>
  );
}

/**
 * Hands the file to the browser.
 *
 * A blob URL and a synthetic click, revoked straight after: there is no
 * server round trip to make here and the theme is already in memory, so
 * anything else would be a download endpoint that exists to avoid this
 * function.
 */
function download(theme: SavedTheme) {
  const blob = new Blob([exportTheme(theme)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${theme.name.replace(/[^a-z0-9-_]+/gi, "-").toLowerCase()}.liffy-theme.json`;
  link.click();
  URL.revokeObjectURL(url);
}
