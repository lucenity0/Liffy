import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Modal } from "@/components/ui/Modal";
import { Sheet } from "@/components/ui/Sheet";
import { SkeletonRows } from "@/components/ui/Skeleton";
import {
  EditableSettingRow,
  ReadOnlySettingRow,
  SecretSettingRow,
} from "@/components/settings/SettingRow";
import { useSettings, useUpdateSettings } from "@/hooks/useSettings";
import { normalizeApiError } from "@/lib/errors";
import type { EditableSetting } from "@/types/api";

const GROUPS = [
  { id: "review_model", title: "Review model" },
  { id: "github_posting", title: "GitHub posting" },
] as const;

/** A pending change, held until the confirm dialog is answered. */
interface PendingChange {
  setting: EditableSetting;
  value: string;
}

/**
 * Configure Liffy from inside Liffy, rather than by guessing which of ~35
 * keys in a dotfile matters.
 *
 * The page deliberately shows more than it lets you change. Settings that
 * cannot take effect at runtime are rendered read-only *with the reason*, and
 * secrets appear as Configured / Not configured — so the page answers "where
 * is this configured?" for everything, while only offering to change what it
 * safely can. A settings page that exposed `database_url` would be worse than
 * none, because it would look authoritative.
 */
export function Settings() {
  const settings = useSettings();
  const save = useUpdateSettings();

  /** Only keys the user has actually touched, so a save sends nothing else. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<PendingChange | null>(null);

  const valueOf = (setting: EditableSetting) =>
    drafts[setting.key] ?? String(setting.value);

  function stage(setting: EditableSetting, next: string) {
    setDrafts((current) => ({ ...current, [setting.key]: next }));
  }

  /**
   * Turning one of the dangerous settings *on* goes through a confirm; turning
   * it off does not. The asymmetry is the point — the risk is all in one
   * direction, and confirming a retreat to the safe state would just train
   * people to dismiss the dialog.
   */
  function request(setting: EditableSetting, next: string) {
    const turningOn =
      setting.kind === "bool" ? next === "true" : next !== setting.default_value;

    if (setting.confirm_on_enable && turningOn) {
      setPending({ setting, value: next });
      return;
    }
    stage(setting, next);
  }

  function confirmPending() {
    if (pending) stage(pending.setting, pending.value);
    setPending(null);
  }

  const dirty = Object.keys(drafts).length > 0;

  function onSave() {
    save.mutate(drafts, { onSuccess: () => setDrafts({}) });
  }

  const apiError = save.isError ? normalizeApiError(save.error) : null;
  /**
   * A 422 names one field's problem, so it belongs on that field. With a
   * single field in flight there is no ambiguity about which; with several,
   * it also shows at the top rather than being attached to a guess.
   */
  const fieldError =
    apiError && Object.keys(drafts).length === 1 ? Object.keys(drafts)[0] : null;

  if (settings.isPending) {
    return (
      <Sheet>
        <Sheet.Header title="Settings" />
        <SkeletonRows rows={6} />
      </Sheet>
    );
  }

  if (settings.isError) {
    return <ErrorNote error={settings.error} onRetry={() => settings.refetch()} />;
  }

  const data = settings.data!;

  /**
   * The provider the page is currently *showing*, drafts included.
   *
   * Read from the draft rather than the saved value so picking a provider
   * swaps its model field in immediately — waiting for a save would mean
   * choosing a provider and a model in two separate round trips, and the whole
   * point of one model control is that you set both in one pass.
   */
  const providerSetting = data.editable.find((s) => s.key === "llm_provider");
  const provider = providerSetting
    ? (drafts[providerSetting.key] ?? String(providerSetting.value))
    : "";

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-hand text-2xl leading-tight text-ink">Settings</h1>
          <p className="max-w-prose text-base text-ink-dim">
            What Liffy uses to run a review. Anything that needs a restart is
            shown here but set in <span className="font-code">backend/.env</span>.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {dirty && <span className="label text-ink-dim">Unsaved</span>}
          <Button
            variant="primary"
            disabled={!dirty}
            loading={save.isPending}
            onClick={onSave}
          >
            Save changes
          </Button>
        </div>
      </header>

      {apiError && !fieldError && (
        <p role="alert" className="text-base text-oxide">
          {apiError.message}
        </p>
      )}

      {GROUPS.map((group) => {
        const rows = data.editable
          .filter((s) => s.group === group.id)
          .filter(
            (s) => s.applies_to.length === 0 || s.applies_to.includes(provider),
          );
        if (rows.length === 0) return null;
        return (
          <Sheet key={group.id}>
            <Sheet.Header title={group.title} />
            {rows.map((setting) => (
              <EditableSettingRow
                key={setting.key}
                setting={setting}
                value={valueOf(setting)}
                disabled={save.isPending}
                error={
                  fieldError === setting.key ? apiError!.message : undefined
                }
                onChange={(next) => request(setting, next)}
              />
            ))}
          </Sheet>
        );
      })}

      <Sheet>
        <Sheet.Header
          title="Secrets"
          actions={<span className="label text-ink-dim">Never sent to the browser</span>}
        />
        {data.secrets.map((secret) => (
          <SecretSettingRow key={secret.key} setting={secret} />
        ))}
      </Sheet>

      <Sheet>
        <Sheet.Header
          title="Infrastructure"
          actions={<span className="label text-ink-dim">Read-only</span>}
        />
        {data.read_only.map((setting) => (
          <ReadOnlySettingRow key={setting.key} setting={setting} />
        ))}
      </Sheet>

      {pending && (
        <Modal
          open
          onClose={() => setPending(null)}
          title={
            pending.setting.key === "post_reviews_to_github"
              ? "Post reviews to real pull requests?"
              : "Send reviews as GitHub review events?"
          }
          footer={
            <>
              <Button onClick={() => setPending(null)}>Cancel</Button>
              <Button variant="primary" onClick={confirmPending}>
                I understand — turn it on
              </Button>
            </>
          }
        >
          {/* Says plainly what will happen outside Liffy. A toggle in a web UI
              is easier to flip than a merge, and the config comment this
              mirrors exists because a merge should not switch it on either. */}
          <p className="text-base text-ink">
            {pending.setting.key === "post_reviews_to_github"
              ? "Liffy will write comments to real pull requests on GitHub, visible to everyone with access to the repository. It is off by default for exactly this reason."
              : "Approve and request changes will be sent as real GitHub review events. A request-changes review blocks a human's merge until it is resolved."}
          </p>
          <p className="mt-3 text-sm text-ink-dim">
            This takes effect on the next review, including reviews run by the
            worker. You can turn it off again here at any time.
          </p>
        </Modal>
      )}
    </div>
  );
}
