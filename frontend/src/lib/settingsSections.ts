import type { ReadOnlySetting } from "@/types/api";

/**
 * Settings, filed by the question they answer.
 *
 * The page used to be one column holding everything at equal weight, so
 * "which model reviews my code" and "where is the Codex binary installed"
 * were the same kind of thing. They are not: one is changed weekly by whoever
 * owns the reviews, the other once by whoever deployed the server.
 *
 * Nothing is dropped. Every setting the API sends lands in exactly one
 * section here, and `unfiled()` below is the check that keeps it true.
 */

export type SectionId =
  | "review"
  | "github"
  | "providers"
  | "secrets"
  | "infrastructure";

export interface SectionSpec {
  id: SectionId;
  label: string;
  description: string;
  /**
   * Sub-groups within the section, in order. Only sections that genuinely
   * have them get any — a disclosure on a flat list is a control that does
   * nothing when you press it.
   */
  groups?: { id: string; label: string }[];
}

export const SECTIONS: SectionSpec[] = [
  {
    id: "review",
    label: "Review",
    description: "How Liffy reviews pull requests.",
  },
  {
    id: "github",
    label: "GitHub",
    description: "What Liffy does with a review once it has written one.",
  },
  {
    id: "providers",
    label: "Providers",
    description:
      "Where each model runtime lives on this server. Set in backend/.env.",
    groups: [
      { id: "claude_code", label: "Claude Code" },
      { id: "codex", label: "Codex" },
      { id: "other", label: "Other" },
    ],
  },
  {
    id: "secrets",
    label: "Secrets",
    description: "Which credentials are configured. Values never reach the browser.",
  },
  {
    id: "infrastructure",
    label: "Infrastructure",
    description:
      "Deployment-level configuration, read when Liffy starts. Changing it means editing backend/.env and restarting.",
    groups: [
      { id: "application", label: "Application" },
      { id: "authentication", label: "Authentication" },
      { id: "indexing", label: "Indexing" },
    ],
  },
];

/** The editable `group` the server stamps, per section. */
export const EDITABLE_GROUP: Partial<Record<SectionId, string>> = {
  review: "review_model",
  github: "github_posting",
};

const INDEXING_KEYS = new Set([
  "embedding_provider",
  "embedding_model",
  "local_embedding_model",
  "chroma_host",
  "chroma_port",
  "chroma_persist_dir",
]);

/**
 * Which section a read-only setting belongs to, and which sub-group inside it.
 *
 * Keyed off the server's `group` first and the key name only where `group`
 * cannot separate them: the model-runtime rows all arrive as `review_model`
 * alongside the editable model settings, but a binary path is not a review
 * setting — it is where a provider is installed.
 */
export function fileReadOnly(
  setting: ReadOnlySetting,
): { section: SectionId; group: string } {
  if (setting.group === "review_model") {
    const provider = setting.key.startsWith("claude_code")
      ? "claude_code"
      : setting.key.startsWith("codex")
        ? "codex"
        : "other";
    return { section: "providers", group: provider };
  }

  if (setting.group === "authentication") {
    return { section: "infrastructure", group: "authentication" };
  }

  return {
    section: "infrastructure",
    group: INDEXING_KEYS.has(setting.key) ? "indexing" : "application",
  };
}

/**
 * Read-only settings this map failed to place under any rendered sub-group.
 *
 * The page's promise is that every setting is *somewhere*. A new key added to
 * the backend would otherwise vanish from the UI silently, which is the worst
 * possible failure for a page whose job is answering "where is this
 * configured?".
 */
export function unfiled(readOnly: ReadOnlySetting[]): ReadOnlySetting[] {
  const known = new Map(
    SECTIONS.filter((section) => section.groups).map((section) => [
      section.id,
      new Set(section.groups!.map((group) => group.id)),
    ]),
  );
  return readOnly.filter((setting) => {
    const { section, group } = fileReadOnly(setting);
    return !known.get(section)?.has(group);
  });
}
