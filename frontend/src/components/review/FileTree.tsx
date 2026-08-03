import { useMemo, useState } from "react";
import { Input } from "@/components/ui/Field";
import {
  allDirPaths,
  buildFileTree,
  filterTree,
  type TreeNode,
} from "@/lib/reviewStats";
import { cn } from "@/lib/utils";

/**
 * The changed files, as a tree rather than a column of full paths.
 *
 * A 24-file review printed as 24 repeated `frontend/src/components/...`
 * strings is unreadable at any rail width; the shared prefixes are the noise
 * and the leaf is the signal. Single-child directory chains fold into one row
 * (see buildFileTree) so the nesting never costs more indentation than it
 * earns.
 */
export function FileTree({
  paths,
  selected,
  commentCounts,
  onSelect,
}: {
  paths: string[];
  selected: string | null;
  commentCounts: Map<string, number>;
  onSelect: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const tree = useMemo(() => buildFileTree(paths), [paths]);
  const visible = useMemo(() => filterTree(tree, query), [tree, query]);

  // Everything open to begin with: the tree exists to show what changed, and
  // a first render of folded directories hides exactly that.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const allDirs = useMemo(() => allDirPaths(tree), [tree]);

  function toggle(path: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  const filtering = query.trim().length > 0;

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <Input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Filter files…"
        aria-label="Filter changed files"
        className="w-full"
      />

      {visible.length === 0 ? (
        <p className="px-1 text-sm text-ink-dim">No files match “{query}”.</p>
      ) : (
        <ul className="flex min-w-0 flex-col overflow-y-auto">
          {visible.map((node) => (
            <TreeRow
              key={node.type === "dir" ? `d:${node.path}` : `f:${node.path}`}
              node={node}
              depth={0}
              selected={selected}
              commentCounts={commentCounts}
              // While filtering, every surviving directory stays open —
              // hiding a match behind a fold defeats the search.
              collapsed={filtering ? EMPTY : collapsed}
              onToggle={toggle}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}

      {/* Reassurance that a fold, not a filter, is why a file is missing. */}
      {!filtering && collapsed.size > 0 && (
        <button
          type="button"
          onClick={() => setCollapsed(new Set())}
          className="px-1 text-left text-2xs text-ink-dim hover:text-ink"
        >
          Expand all {allDirs.length} folders
        </button>
      )}
    </div>
  );
}

const EMPTY: Set<string> = new Set();

function TreeRow({
  node,
  depth,
  selected,
  commentCounts,
  collapsed,
  onToggle,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selected: string | null;
  commentCounts: Map<string, number>;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  // Indent in padding rather than margin so the active row's fill still
  // reaches the rail's left edge.
  const indent = { paddingLeft: `${depth * 12 + 4}px` };

  if (node.type === "dir") {
    const isCollapsed = collapsed.has(node.path);
    return (
      <li>
        <button
          type="button"
          onClick={() => onToggle(node.path)}
          aria-expanded={!isCollapsed}
          style={indent}
          className="flex w-full items-center gap-1.5 rounded-chip py-1 pr-2 text-left text-sm text-ink-dim hover:bg-neutral-tint hover:text-ink"
        >
          <span
            aria-hidden="true"
            className={cn(
              "inline-block w-2 shrink-0 transition-transform duration-100",
              !isCollapsed && "rotate-90",
            )}
          >
            ›
          </span>
          <span className="truncate font-code">{node.name}</span>
        </button>

        {!isCollapsed && (
          <ul className="flex flex-col">
            {node.children.map((child) => (
              <TreeRow
                key={child.type === "dir" ? `d:${child.path}` : `f:${child.path}`}
                node={child}
                depth={depth + 1}
                selected={selected}
                commentCounts={commentCounts}
                collapsed={collapsed}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const count = commentCounts.get(node.path) ?? 0;
  const isSelected = node.path === selected;

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(node.path)}
        aria-current={isSelected ? "true" : undefined}
        title={node.path}
        style={indent}
        className={cn(
          "flex w-full items-center gap-2 rounded-chip py-1 pr-2 text-left text-sm",
          isSelected
            ? "bg-neutral-tint font-medium text-ink"
            : "text-ink-dim hover:bg-neutral-tint hover:text-ink",
        )}
      >
        {/* Leading spacer keeps filenames on the same optical column as the
            sibling directory labels, whose disclosure arrow occupies it. */}
        <span aria-hidden="true" className="inline-block w-2 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-code">{node.name}</span>
        {count > 0 && (
          <span
            data-numeric
            // Subtle, per the brief: this is a count, not a notification.
            className="shrink-0 text-2xs text-ink-sub"
            title={`${count} comment${count === 1 ? "" : "s"}`}
          >
            {count}
          </span>
        )}
      </button>
    </li>
  );
}
