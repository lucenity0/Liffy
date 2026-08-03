import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { Appearance } from "@/components/settings/Appearance";
import { SettingsNav } from "@/components/settings/SettingsNav";
import {
  EDITABLE_GROUP,
  fileReadOnly,
  SECTIONS,
  unfiled,
} from "@/lib/settingsSections";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Modal } from "@/components/ui/Modal";
import { Sheet } from "@/components/ui/Sheet";
import { SkeletonRows } from "@/components/ui/Skeleton";
import {
  EditableSettingRow,
  ReadOnlySettingRow,
  SecretSettingRow,
} from "@/components/settings/SettingRow";
import { Input } from "@/components/ui/Field";
import {
  useConnectSecret,
  useDisconnectSecret,
  useSettings,
  useUpdateSettings,
} from "@/hooks/useSettings";
import { normalizeApiError } from "@/lib/errors";
import type {
  EditableSetting,
  ReadOnlySetting,
  SecretSetting,
} from "@/types/api";


/** A pending change, held until the confirm dialog is answered. */
interface PendingChange {
  setting: EditableSetting;
  value: string;
}

/**
 * What each confirmed setting actually does outside Liffy.
 *
 * Keyed rather than branched so adding a fourth does not silently inherit the
 * wrong warning — the dialog is the only thing standing between a dropdown and
 * an effect somebody else sees.
 */
const CONFIRM_COPY: Record<string, { title: string; body: string }> = {
  post_reviews_to_github: {
    title: "Post reviews to real pull requests?",
    body: "Liffy will write comments to real pull requests on GitHub, visible to everyone with access to the repository. It is off by default for exactly this reason.",
  },
  github_review_event_mode: {
    title: "Send reviews as GitHub review events?",
    body: "Approve and request changes will be sent as real GitHub review events. A request-changes review blocks a human's merge until it is resolved.",
  },
  openai_base_url: {
    title: "Send your code to a different endpoint?",
    body: "Every review from now on sends the diff and the retrieved context to this address. If it is not a localhost URL, that means your code leaves this machine and reaches whoever operates that endpoint, under their terms.",
  },
};

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
  const [searchParams, setSearchParams] = useSearchParams();

  const section =
    SECTIONS.find((s) => s.id === searchParams.get("section")) ?? SECTIONS[0];

  /** Only keys the user has actually touched, so a save sends nothing else. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<PendingChange | null>(null);
  /** The credential whose connect dialog is open, if any. */
  const [connecting, setConnecting] = useState<SecretSetting | null>(null);
  const [token, setToken] = useState("");
  const connect = useConnectSecret();
  const disconnect = useDisconnectSecret();

  function submitToken() {
    if (!connecting) return;
    connect.mutate(
      { key: connecting.key, value: token },
      {
        onSuccess: () => {
          setConnecting(null);
          setToken("");
        },
      },
    );
  }

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

  const editableGroup = EDITABLE_GROUP[section.id];
  const editableRows = editableGroup
    ? data.editable
        .filter((s) => s.group === editableGroup)
        .filter(
          (s) => s.applies_to.length === 0 || s.applies_to.includes(provider),
        )
    : [];

  /** This section's read-only rows, bucketed into its sub-groups. */
  const readOnlyByGroup = new Map<string, ReadOnlySetting[]>();
  for (const setting of data.read_only) {
    const filed = fileReadOnly(setting);
    if (filed.section !== section.id) continue;
    const bucket = readOnlyByGroup.get(filed.group);
    if (bucket) bucket.push(setting);
    else readOnlyByGroup.set(filed.group, [setting]);
  }

  const stragglers = unfiled(data.read_only);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Settings"
        description={
          <>
            What Liffy uses to run a review. Anything that needs a restart is
            shown here but set in <span className="font-code">backend/.env</span>.
          </>
        }
        actions={
          <>
            {dirty && <span className="label text-ink-dim">Unsaved</span>}
            <Button
              variant="primary"
              disabled={!dirty}
              loading={save.isPending}
              onClick={onSave}
            >
              Save changes
            </Button>
          </>
        }
      />

      {apiError && !fieldError && (
        <p role="alert" className="text-base text-oxide">
          {apiError.message}
        </p>
      )}

      {/* Local nav beside the content. Below `lg` it stacks above rather
          than shrinking into a column too narrow to read — the brief is
          explicit that a tiny two-column layout is worse than none. */}
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <div className="w-full shrink-0 lg:sticky lg:top-14 lg:w-48">
          <SettingsNav
            active={section.id}
            onSelect={(id, group) => {
              const params = new URLSearchParams(searchParams);
              if (id === "review") params.delete("section");
              else params.set("section", id);
              setSearchParams(params, { replace: true });
              if (group) {
                // The sub-item scrolls to its group inside the section it
                // belongs to, so selecting one always lands somewhere real
                // even when the section was not already open.
                requestAnimationFrame(() =>
                  document
                    .getElementById(`settings-${id}-${group}`)
                    ?.scrollIntoView({ block: "start", behavior: "smooth" }),
                );
              }
            }}
          />
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-6">
          <div className="flex flex-col gap-1">
            <h2 className="font-hand text-lg leading-tight text-ink">
              {section.label}
            </h2>
            <p className="text-sm text-ink-dim">{section.description}</p>
          </div>

          {/* Appearance leads the Review section rather than getting a
              section of its own: it is one card, and a nav entry holding a
              single card is a heavier promise than it can keep. */}
          {section.id === "review" && <Appearance />}

          {editableGroup && (
            <Sheet>
              <Sheet.Header title={section.label} />
              {editableRows.length === 0 ? (
                <Sheet.Body>
                  <p className="text-base text-ink-dim">
                    Nothing to configure here for the selected provider.
                  </p>
                </Sheet.Body>
              ) : (
                editableRows.map((setting) => (
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
                ))
              )}
            </Sheet>
          )}

          {section.id === "secrets" && (
            <Sheet>
              <Sheet.Header
                title="Secrets"
                actions={
                  <span className="label text-ink-dim">
                    Never sent to the browser
                  </span>
                }
              />
              {data.secrets.map((secret) => (
                <SecretSettingRow
                  key={secret.key}
                  // Only credentials the backend marks connectable get the
                  // action — the rest stay report-only, which is what keeps
                  // `jwt_secret_key` out of reach of a settings request.
                  onConnect={
                    secret.connectable ? () => setConnecting(secret) : undefined
                  }
                  onDisconnect={
                    secret.connectable
                      ? () => disconnect.mutate(secret.key)
                      : undefined
                  }
                  setting={secret}
                  // Every secret stays listed — the page's job is answering
                  // "where is this configured?" for everything. But an unset
                  // key belonging to a provider you did not pick is not a
                  // problem, and should not be dressed as one.
                  relevant={
                    secret.applies_to.length === 0 ||
                    secret.applies_to.includes(provider)
                  }
                />
              ))}
            </Sheet>
          )}

          {section.groups?.map((group) => {
            const rows = readOnlyByGroup.get(group.id) ?? [];
            if (rows.length === 0) return null;
            return (
              <Sheet
                key={group.id}
                id={`settings-${section.id}-${group.id}`}
                className="scroll-mt-16"
              >
                <Sheet.Header
                  title={group.label}
                  actions={<span className="label text-ink-dim">Read-only</span>}
                />
                {rows.map((setting) => (
                  <ReadOnlySettingRow key={setting.key} setting={setting} />
                ))}
              </Sheet>
            );
          })}

          {/* Nothing is allowed to go missing. A key the backend adds that
              this page has no home for would otherwise vanish silently —
              the worst failure for a page whose job is answering "where is
              this configured?". */}
          {section.id === "infrastructure" && stragglers.length > 0 && (
            <Sheet>
              <Sheet.Header
                title="Other"
                actions={<span className="label text-ink-dim">Read-only</span>}
              />
              {stragglers.map((setting) => (
                <ReadOnlySettingRow key={setting.key} setting={setting} />
              ))}
            </Sheet>
          )}
        </div>
      </div>

      {pending && (
        <Modal
          open
          onClose={() => setPending(null)}
          title={CONFIRM_COPY[pending.setting.key]?.title ?? "Are you sure?"}
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
            {CONFIRM_COPY[pending.setting.key]?.body ??
              "This setting reaches outside Liffy."}
          </p>
          <p className="mt-3 text-sm text-ink-dim">
            This takes effect on the next review, including reviews run by the
            worker. You can turn it off again here at any time.
          </p>
        </Modal>
      )}

      {connecting && (
        <Modal
          open
          onClose={() => {
            setConnecting(null);
            setToken("");
          }}
          title={`Connect ${connecting.label}`}
          footer={
            <>
              <Button
                onClick={() => {
                  setConnecting(null);
                  setToken("");
                }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={connect.isPending}
                disabled={!token.trim()}
                onClick={submitToken}
              >
                Connect
              </Button>
            </>
          }
        >
          {/* Liffy cannot run the login for you: the CLI's is a browser flow
              with no headless mode. What it can do is be the last place the
              value has to go, instead of sending you to a dotfile. */}
          <p className="text-base text-ink">
            Run this on the machine you are signed in on, then paste what it
            prints:
          </p>
          <pre className="mt-2 overflow-x-auto rounded-chip bg-recessed px-3 py-2 font-code text-sm text-ink">
            {connecting.connect_command}
          </pre>
          <Input
            className="mt-3 w-full"
            type="password"
            autoFocus
            aria-label={`${connecting.label} value`}
            value={token}
            placeholder="Paste the token"
            onChange={(event) => setToken(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && token.trim()) submitToken();
            }}
          />
          {connect.isError && (
            <p role="alert" className="mt-2 text-sm text-oxide">
              {normalizeApiError(connect.error).message}
            </p>
          )}
          <p className="mt-3 text-sm text-ink-dim">
            Checked with Anthropic before it is stored, then kept in Liffy's
            database — not in backend/.env. It is never sent back to the
            browser, and Disconnect removes it here without revoking it at
            Anthropic.
          </p>
        </Modal>
      )}
    </div>
  );
}
