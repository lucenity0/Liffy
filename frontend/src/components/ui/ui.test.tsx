import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { Sheet } from "./Sheet";
import { Badge } from "./Badge";
import {
  CategoryBadge,
  IndexBadge,
  SeverityBadge,
  StatusBadge,
  VerdictBadge,
} from "./badgeMaps";
import { Button } from "./Button";
import { Spinner } from "./Spinner";
import { EmptyState } from "./EmptyState";
import { ErrorBoundary } from "./ErrorBoundary";
import { Field, Input } from "./Field";
import { Modal } from "./Modal";
import type {
  Category,
  IndexStatus,
  ReviewStatus,
  Severity,
  Verdict,
} from "@/types/api";

const wrap = (ui: React.ReactNode) =>
  render(<MemoryRouter>{ui}</MemoryRouter>);

describe("Sheet", () => {
  it("renders header title, counter and actions", () => {
    wrap(
      <Sheet>
        <Sheet.Header
          title="Repositories"
          count={3}
          actions={<Button>Connect</Button>}
        />
        <Sheet.List>
          <Sheet.Row>one</Sheet.Row>
        </Sheet.List>
      </Sheet>,
    );

    expect(screen.getByRole("heading", { name: "Repositories" })).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
  });

  it("renders a row as a link only when `to` is given", () => {
    wrap(
      <Sheet>
        <Sheet.List>
          <Sheet.Row to="/reviews/abc">linked</Sheet.Row>
          <Sheet.Row>plain</Sheet.Row>
        </Sheet.List>
      </Sheet>,
    );

    expect(screen.getByRole("link", { name: "linked" })).toHaveAttribute(
      "href",
      "/reviews/abc",
    );
    expect(screen.queryByRole("link", { name: "plain" })).toBeNull();
  });

  it("keeps a linked row laid out as flex, so ml-auto still works", () => {
    // Regression: the Link branch used to add `block`, which beat `flex` in
    // the cascade and silently killed every trailing `ml-auto` cell.
    wrap(
      <Sheet>
        <Sheet.List>
          <Sheet.Row to="/x">row</Sheet.Row>
        </Sheet.List>
      </Sheet>,
    );

    const row = screen.getByRole("link", { name: "row" });
    expect(row.className).toMatch(/\bflex\b/);
    expect(row.className).not.toMatch(/\bblock\b/);
  });

  it("drops border and shadow when flush, so nesting cannot double hairlines", () => {
    const { container } = wrap(<Sheet tone="flush">nested</Sheet>);
    const sheet = container.querySelector("section")!;

    expect(sheet.className).not.toMatch(/\bborder\b/);
    expect(sheet.className).not.toMatch(/shadow-hard/);
  });

  it("children override the default header layout entirely", () => {
    wrap(
      <Sheet>
        <Sheet.Header title="ignored">
          <span>custom</span>
        </Sheet.Header>
      </Sheet>,
    );

    expect(screen.getByText("custom")).toBeInTheDocument();
    expect(screen.queryByText("ignored")).toBeNull();
  });
});

describe("Badge", () => {
  it("applies a distinct class set for every tone and variant", () => {
    const tones = ["neutral", "oxide", "sage", "ochre", "payne", "ink"] as const;
    const variants = ["tint", "outline", "solid"] as const;
    const seen = new Set<string>();

    for (const tone of tones) {
      for (const variant of variants) {
        const { container, unmount } = render(
          <Badge tone={tone} variant={variant}>
            x
          </Badge>,
        );
        seen.add(container.querySelector("span")!.className);
        unmount();
      }
    }

    // 18 combinations, 18 distinct class strings — no silent collapsing.
    expect(seen.size).toBe(tones.length * variants.length);
  });

  it("renders the dot only when asked", () => {
    const { container, rerender } = render(<Badge>plain</Badge>);
    expect(container.querySelectorAll("span")).toHaveLength(1);

    rerender(<Badge dot>dotted</Badge>);
    expect(container.querySelectorAll("span")).toHaveLength(2);
  });
});

describe("badge enum maps", () => {
  it.each<[ReviewStatus, string]>([
    ["pending", "Pending"],
    ["processing", "Processing"],
    ["completed", "Completed"],
    ["failed", "Failed"],
  ])("status %s renders %s", (value, label) => {
    render(<StatusBadge value={value} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it.each<[Verdict, string]>([
    ["approve", "Approve"],
    ["request_changes", "Request changes"],
    ["comment", "Comment"],
  ])("verdict %s renders %s", (value, label) => {
    render(<VerdictBadge value={value} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it.each<[Severity, string]>([
    ["critical", "Critical"],
    ["warning", "Warning"],
    ["info", "Info"],
  ])("severity %s renders %s", (value, label) => {
    render(<SeverityBadge value={value} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it.each<[Category, string]>([
    ["logic_error", "Logic"],
    ["security", "Security"],
    ["performance", "Perf"],
    ["architecture", "Architecture"],
    ["convention", "Convention"],
    ["improvement", "Improvement"],
  ])("category %s renders %s", (value, label) => {
    render(<CategoryBadge value={value} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it.each<[IndexStatus, string]>([
    ["indexed", "Indexed"],
    ["not_indexed", "Indexing"],
  ])("index %s renders %s", (value, label) => {
    render(<IndexBadge value={value} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("falls back to the raw value when the API sends something off-union", () => {
    // The backend types these columns as `str` and the LLM populates them.
    render(<StatusBadge value={"rate_limited" as ReviewStatus} />);
    expect(screen.getByText("rate limited")).toBeInTheDocument();
  });
});

describe("Button", () => {
  it("shows a spinner and blocks clicks while loading", async () => {
    const onClick = vi.fn();
    wrap(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );

    const button = screen.getByRole("button", { name: /save/i });
    expect(button).toBeDisabled();
    await userEvent.click(button).catch(() => {});
    expect(onClick).not.toHaveBeenCalled();
    expect(within(button).getByRole("status")).toBeInTheDocument();
  });

  it("defaults to type=button so it never submits a form by accident", () => {
    wrap(<Button>Go</Button>);
    expect(screen.getByRole("button", { name: "Go" })).toHaveAttribute(
      "type",
      "button",
    );
  });
});

describe("Spinner", () => {
  it("exposes a status role with an accessible label", () => {
    render(<Spinner label="Indexing" />);
    expect(screen.getByRole("status", { name: "Indexing" })).toBeInTheDocument();
  });
});

describe("EmptyState", () => {
  it("renders the CTA only when provided", () => {
    const { rerender } = wrap(
      <EmptyState title="No reviews yet" description="Trigger one." />,
    );
    expect(screen.getByText("No reviews yet")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();

    rerender(
      <MemoryRouter>
        <EmptyState title="No reviews yet" action={<Button>New</Button>} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: "New" })).toBeInTheDocument();
  });
});

describe("Field", () => {
  it("wires label, hint and error through aria attributes", () => {
    wrap(
      <Field label="Repository" hint="owner/name" required>
        {(props) => <Input {...props} />}
      </Field>,
    );

    const input = screen.getByLabelText(/repository/i);
    expect(input).toBeRequired();
    expect(input).toHaveAccessibleDescription("owner/name");
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("replaces the hint with the error and marks the field invalid", () => {
    wrap(
      <Field label="Repository" hint="owner/name" error="That looks wrong">
        {(props) => <Input {...props} />}
      </Field>,
    );

    const input = screen.getByLabelText(/repository/i);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("That looks wrong");
    expect(screen.queryByText("owner/name")).toBeNull();
  });
});

describe("ErrorBoundary", () => {
  function Boom(): React.ReactElement {
    throw new Error("kaboom");
  }

  it("catches a throwing child and can be reset", async () => {
    // React logs caught errors; the throw here is the point of the test.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    function Harness() {
      const [broken, setBroken] = useState(true);
      return (
        <ErrorBoundary
          fallback={(error, reset) => (
            <div>
              <span>caught: {error.message}</span>
              <button
                onClick={() => {
                  setBroken(false);
                  reset();
                }}
              >
                retry
              </button>
            </div>
          )}
        >
          {broken ? <Boom /> : <span>recovered</span>}
        </ErrorBoundary>
      );
    }

    wrap(<Harness />);
    expect(screen.getByText(/caught: kaboom/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "retry" }));
    expect(screen.getByText("recovered")).toBeInTheDocument();

    spy.mockRestore();
  });

  it("renders the default panel when no fallback is given", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    wrap(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByText("kaboom")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();

    spy.mockRestore();
  });
});

describe("Modal", () => {
  it("opens as a modal dialog and closes on Esc", async () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <Modal open={open} onClose={() => setOpen(false)} title="Connect">
          <span>body</span>
        </Modal>
      );
    }

    wrap(<Harness />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeVisible();
    expect(screen.getByText("body")).toBeInTheDocument();

    // Esc fires `cancel`, not `close` — the component has to translate it.
    // A closed <dialog> stops exposing the dialog role entirely.
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(dialog).not.toHaveAttribute("open");
  });

  it("closes on the close button but not on a click inside the body", async () => {
    const onClose = vi.fn();
    wrap(
      <Modal open onClose={onClose} title="Connect">
        <span>body</span>
      </Modal>,
    );

    await userEvent.click(screen.getByText("body"));
    expect(onClose).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
