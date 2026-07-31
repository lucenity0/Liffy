"""Diff two `prompt_baseline.py` runs, per PR and in aggregate.

    python scripts/prompt_compare.py before after

Reports only what a prompt change can move: comment volume, category and
severity spread, verdict, and tokens. It deliberately does **not** compute an
"improvement" score — the per-comment correct/false/unverifiable assessment is
a human judgement recorded by hand in the artifacts, and inventing a metric
over it would dress up an opinion as a measurement.
"""

import collections
import json
import pathlib
import sys

from app.schemas.review import ReviewCategory, ReviewSeverity

DOCS = pathlib.Path(__file__).resolve().parents[2] / "docs" / "prompt-eval"


def load(label: str) -> dict:
    return json.loads((DOCS / f"{label}.json").read_text())


def _spread(runs: list[dict], key: str, enum) -> dict[str, int]:
    counts = collections.Counter(
        c[key] for r in runs for c in r.get("comments", [])
    )
    return {member.value: counts.get(member.value, 0) for member in enum}


def _assessments(runs: list[dict]) -> collections.Counter:
    return collections.Counter(
        c.get("assessment") or "unassessed"
        for r in runs
        for c in r.get("comments", [])
    )


def main(before_label: str, after_label: str) -> None:
    before, after = load(before_label), load(after_label)
    b_runs = [r for r in before["runs"] if "error" not in r]
    a_runs = [r for r in after["runs"] if "error" not in r]

    print(f"{'':<6} {before_label:>24}   {after_label:>24}")
    print(f"{'':<6} {'-' * 24}   {'-' * 24}")

    print("\n── per PR ──")
    print(f"{'PR':<6} {'verdict':>16} {'cmts':>5} {'tok':>7}   "
          f"{'verdict':>16} {'cmts':>5} {'tok':>7}")
    by_pr = {r["pr"]: r for r in a_runs}
    for run in b_runs:
        other = by_pr.get(run["pr"], {})
        print(
            f"#{run['pr']:<5} {str(run['verdict']):>16} {run['comment_count']:>5} "
            f"{run['tokens_used'] or 0:>7}   "
            f"{str(other.get('verdict')):>16} {other.get('comment_count', 0):>5} "
            f"{other.get('tokens_used') or 0:>7}"
        )

    print("\n── totals ──")
    for name, b_val, a_val in [
        ("comments", sum(r["comment_count"] for r in b_runs),
         sum(r["comment_count"] for r in a_runs)),
        ("tokens", sum(r["tokens_used"] or 0 for r in b_runs),
         sum(r["tokens_used"] or 0 for r in a_runs)),
    ]:
        delta = a_val - b_val
        print(f"{name:<10} {b_val:>10} -> {a_val:>10}   ({delta:+})")

    print("\n── category spread ──")
    b_cat, a_cat = _spread(b_runs, "category", ReviewCategory), _spread(a_runs, "category", ReviewCategory)
    for key in b_cat:
        print(f"{key:<14} {b_cat[key]:>4} -> {a_cat[key]:>4}")

    print("\n── severity spread ──")
    b_sev, a_sev = _spread(b_runs, "severity", ReviewSeverity), _spread(a_runs, "severity", ReviewSeverity)
    for key in b_sev:
        print(f"{key:<14} {b_sev[key]:>4} -> {a_sev[key]:>4}")

    print("\n── per-comment assessment (recorded by hand) ──")
    b_ass, a_ass = _assessments(b_runs), _assessments(a_runs)
    for key in ("correct", "false", "unverifiable", "unassessed"):
        print(f"{key:<14} {b_ass.get(key, 0):>4} -> {a_ass.get(key, 0):>4}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
