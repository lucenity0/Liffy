import type { FileDiff } from "@/lib/diff";
import type { Category, ReviewCommentOut, Severity } from "@/types/api";

/**
 * Everything the review workspace counts, derived from what the API already
 * sends.
 *
 * The redesign asks for per-file `+/−` counts, a hierarchical file tree,
 * per-file comment counts, severity totals and a category breakdown. None of
 * that is a backend field and none of it needs to be: the diff carries the
 * line kinds and the comments carry their own file, severity and category.
 * Deriving it here keeps that promise checkable in one place rather than
 * spread across four tab components.
 */

export interface FileStat {
  additions: number;
  deletions: number;
}

export function fileStat(file: FileDiff): FileStat {
  let additions = 0;
  let deletions = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "added") additions++;
      else if (line.kind === "removed") deletions++;
    }
  }
  return { additions, deletions };
}

export function totalStat(files: FileDiff[]): FileStat & { files: number } {
  return files.reduce(
    (total, file) => {
      const { additions, deletions } = fileStat(file);
      return {
        files: total.files + 1,
        additions: total.additions + additions,
        deletions: total.deletions + deletions,
      };
    },
    { files: 0, additions: 0, deletions: 0 },
  );
}

/** Comment counts per file path, for the tree's subtle per-file number. */
export function commentCounts(
  comments: ReviewCommentOut[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const comment of comments) {
    counts.set(comment.file_path, (counts.get(comment.file_path) ?? 0) + 1);
  }
  return counts;
}

export type SeverityCounts = Record<Severity, number>;

/**
 * All three severities, always — including the zeroes.
 *
 * "0 critical" is the single most reassuring thing this page can say, and it
 * only says it if the key is present. Counting only what occurred would drop
 * exactly the rows worth reading.
 */
export function severityCounts(comments: ReviewCommentOut[]): SeverityCounts {
  const counts: SeverityCounts = { critical: 0, warning: 0, info: 0 };
  for (const comment of comments) {
    if (comment.severity in counts) counts[comment.severity]++;
  }
  return counts;
}

/** Category totals, worst-represented first, zeroes kept for the same reason. */
export function categoryCounts(
  comments: ReviewCommentOut[],
  categories: readonly Category[],
): { category: Category; count: number }[] {
  const counts = new Map<string, number>();
  for (const comment of comments) {
    counts.set(comment.category, (counts.get(comment.category) ?? 0) + 1);
  }
  return categories
    .map((category) => ({ category, count: counts.get(category) ?? 0 }))
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// File tree

export interface TreeFile {
  type: "file";
  /** The segment shown in the tree. */
  name: string;
  /** The full path, which is the selection key everywhere else. */
  path: string;
}

export interface TreeDir {
  type: "dir";
  name: string;
  /** Joined segments so far — the key the collapse state is stored under. */
  path: string;
  children: TreeNode[];
}

export type TreeNode = TreeDir | TreeFile;

/**
 * Paths into a directory tree.
 *
 * Directory chains with a single child are collapsed into one row
 * (`frontend/src/components` rather than three nested rows each holding one
 * thing) — a real repository is mostly such chains, and expanding every one
 * of them pushes the actual filenames off the right of a 240px rail.
 */
export function buildFileTree(paths: string[]): TreeNode[] {
  const root: TreeDir = { type: "dir", name: "", path: "", children: [] };

  for (const path of [...paths].sort((a, b) => a.localeCompare(b))) {
    const segments = path.split("/");
    let cursor = root;

    segments.forEach((segment, index) => {
      if (index === segments.length - 1) {
        cursor.children.push({ type: "file", name: segment, path });
        return;
      }
      const dirPath = segments.slice(0, index + 1).join("/");
      const existing = cursor.children.find(
        (child): child is TreeDir => child.type === "dir" && child.path === dirPath,
      );
      if (existing) {
        cursor = existing;
      } else {
        const dir: TreeDir = { type: "dir", name: segment, path: dirPath, children: [] };
        cursor.children.push(dir);
        cursor = dir;
      }
    });
  }

  return collapse(root.children);
}

function collapse(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    if (node.type === "file") return node;

    let dir = node;
    // Fold `a` -> `a/b` -> `a/b/c` into one `a/b/c` row for as long as each
    // level holds exactly one directory and nothing else.
    while (dir.children.length === 1 && dir.children[0].type === "dir") {
      const only = dir.children[0];
      dir = { ...only, name: `${dir.name}/${only.name}` };
    }
    return { ...dir, children: collapse(dir.children) };
  });
}

/** Every directory path in a tree, for "expand everything by default". */
export function allDirPaths(nodes: TreeNode[]): string[] {
  return nodes.flatMap((node) =>
    node.type === "dir" ? [node.path, ...allDirPaths(node.children)] : [],
  );
}

/**
 * Keeps only files matching `query`, and the directories on their way.
 *
 * Matches on the full path rather than the leaf, so "hooks/" narrows to a
 * directory and "useRe" narrows to a filename, without a second control.
 */
export function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return nodes;

  const walk = (list: TreeNode[]): TreeNode[] =>
    list.flatMap((node): TreeNode[] => {
      if (node.type === "file") {
        return node.path.toLowerCase().includes(needle) ? [node] : [];
      }
      const children = walk(node.children);
      return children.length ? [{ ...node, children }] : [];
    });

  return walk(nodes);
}
