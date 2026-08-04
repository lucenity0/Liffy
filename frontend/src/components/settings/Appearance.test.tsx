import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { Appearance } from "./Appearance";
import { APPEARANCE_KEY } from "@/hooks/useAppearance";
import { LIBRARY_KEY } from "@/lib/theme/library";
import { THEME_KEY } from "@/hooks/useTheme";

/**
 * The three complaints this page was rebuilt around:
 *
 *   1. no way to tell which control does what,
 *   2. no way to see the effect without saving and navigating away,
 *   3. no way to keep a theme you made.
 *
 * So the tests are about those, not about the markup: a section is a named
 * group, a control lands immediately, the preview is on screen throughout,
 * and a saved theme comes back.
 */

beforeEach(() => {
  localStorage.clear();
  document.getElementById("liffy-appearance")?.remove();
  const root = document.documentElement;
  delete root.dataset.theme;
  root.classList.remove("dark", "light");
});

const style = () => document.getElementById("liffy-appearance")?.textContent ?? "";

/**
 * Scoped to the Navigation group on purpose: "Compact" is also a density and
 * a line height, so a bare name query matches three unrelated controls and
 * the failure reads as a missing element rather than an ambiguous one.
 */
const navOption = (label: string) =>
  within(screen.getByRole("radiogroup", { name: "Navigation" })).getByText(label);

describe("Appearance", () => {
  it("opens on Theme, with the other three layers named rather than flattened", () => {
    render(<Appearance />);

    const nav = screen.getByRole("navigation", { name: "Appearance sections" });
    for (const label of ["Theme", "Typography", "Layout", "Advanced"]) {
      expect(within(nav).getByText(label)).toBeInTheDocument();
    }
    // Theme is where the page opens: a preset and a radius is the whole job
    // for most people, and colour pickers are two layers further in.
    expect(within(nav).getByText("Theme").closest("button")).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("keeps the preview on screen from the first render", () => {
    render(<Appearance />);
    // The whole point: judging a change never requires leaving the page.
    expect(screen.getByText("Live preview")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "dashboard" })).toBeInTheDocument();
  });

  it("applies a typography change immediately, with no save step", async () => {
    const user = userEvent.setup();
    render(<Appearance />);

    await user.click(screen.getByRole("button", { name: /Typography/ }));
    // Driven directly: a range input responds to neither click position nor
    // arrow keys under jsdom.
    fireEvent.change(screen.getByRole("slider", { name: "UI scale" }), {
      target: { value: "1.05" },
    });

    expect(style()).toContain("--ui-scale:1.05");
    expect(JSON.parse(localStorage.getItem(APPEARANCE_KEY)!).scale).toBe(1.05);
  });

  it("applies a layout choice immediately", async () => {
    const user = userEvent.setup();
    render(<Appearance />);

    await user.click(screen.getByRole("button", { name: /Layout/ }));
    await user.click(navOption("Compact"));

    expect(document.documentElement.getAttribute("data-nav")).toBe("compact");
  });

  it("finds a component by what someone would call it, and opens its editor", async () => {
    const user = userEvent.setup();
    render(<Appearance />);

    await user.click(screen.getByRole("button", { name: /⌘K components/ }));
    await user.type(
      screen.getByRole("textbox", { name: "Search components" }),
      "pr",
    );
    await user.keyboard("{Enter}");

    // Landed in Advanced, editing the thing that was chosen.
    expect(screen.getByText("Editing")).toBeInTheDocument();
    expect(screen.getByText("Review Header")).toBeInTheDocument();
    // And it moved the preview to the surface that component lives on.
    expect(screen.getByRole("tab", { name: "reviews" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("writes an override that selects only the chosen component", async () => {
    const user = userEvent.setup();
    render(<Appearance />);

    await user.click(screen.getByRole("button", { name: /⌘K components/ }));
    await user.type(
      screen.getByRole("textbox", { name: "Search components" }),
      "metric",
    );
    await user.keyboard("{Enter}");

    fireEvent.change(screen.getByRole("slider", { name: "Corner radius" }), {
      target: { value: "6" },
    });

    expect(style()).toContain('[data-liffy="metric-card"]');
    expect(style()).not.toContain('[data-liffy="dashboard-card"]');
  });

  it("shows a knob as following the theme until it is touched", async () => {
    const user = userEvent.setup();
    render(<Appearance />);

    await user.click(screen.getByRole("button", { name: /⌘K components/ }));
    await user.type(
      screen.getByRole("textbox", { name: "Search components" }),
      "sidebar",
    );
    await user.keyboard("{Enter}");

    // An override you cannot distinguish from the theme's own value is the
    // state the old token list left you in.
    expect(screen.getAllByText("follows the theme").length).toBeGreaterThan(0);
  });

  it("only offers the knobs the chosen component accepts", async () => {
    const user = userEvent.setup();
    render(<Appearance />);

    await user.click(screen.getByRole("button", { name: /⌘K components/ }));
    await user.type(
      screen.getByRole("textbox", { name: "Search components" }),
      "review row",
    );
    await user.keyboard("{Enter}");

    expect(screen.getByText("Review Row")).toBeInTheDocument();
    // review-row declares no shadow and no radius, so neither appears at all
    // — absent rather than disabled, because the registry says they would do
    // nothing.
    expect(screen.queryByRole("slider", { name: "Corner radius" })).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "Shadow" })).toBeNull();
  });

  it("saves a theme and lists it, so an experiment survives the next one", async () => {
    const user = userEvent.setup();
    render(<Appearance />);

    await user.click(screen.getByRole("button", { name: /Typography/ }));
    fireEvent.change(screen.getByRole("slider", { name: "UI scale" }), {
      target: { value: "1.05" },
    });

    await user.type(screen.getByLabelText("Name this theme"), "Midnight");
    await user.click(screen.getByRole("button", { name: "Save current" }));

    expect(screen.getByText("Midnight")).toBeInTheDocument();
    const saved = JSON.parse(localStorage.getItem(LIBRARY_KEY)!);
    expect(saved).toHaveLength(1);
    expect(saved[0].appearance.scale).toBe(1.05);
  });

  it("restores both halves of a saved theme when it is applied", async () => {
    const user = userEvent.setup();
    render(<Appearance />);

    // Save one look…
    await user.click(screen.getByRole("button", { name: /Layout/ }));
    await user.click(navOption("Compact"));
    await user.type(screen.getByLabelText("Name this theme"), "Tight");
    await user.click(screen.getByRole("button", { name: "Save current" }));

    // …drift away from it…
    await user.click(navOption("Sidebar"));
    expect(document.documentElement.getAttribute("data-nav")).toBe("rail");

    // …and come back.
    const row = screen.getByText("Tight").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Use" }));

    expect(document.documentElement.getAttribute("data-nav")).toBe("compact");
  });

  it("resets everything, which is what undo means on a page with no Cancel", async () => {
    const user = userEvent.setup();
    render(<Appearance />);

    await user.click(screen.getByRole("button", { name: /Layout/ }));
    await user.click(navOption("Compact"));
    await user.click(screen.getByRole("button", { name: "Reset" }));

    expect(document.documentElement.getAttribute("data-nav")).toBe("rail");
    // Reset offers itself only while there is something to undo.
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
  });

  it("still says where these settings live", () => {
    render(<Appearance />);
    // The distinction the rest of Settings turns on: server configuration
    // behind a PATCH, versus a preference in this browser.
    expect(screen.getByText("Stored in this browser")).toBeInTheDocument();
  });

  it("selecting a preset writes the theme the boot script will read", async () => {
    const user = userEvent.setup();
    render(<Appearance />);

    await user.click(screen.getByRole("button", { name: /Paper/ }));

    expect(document.documentElement.dataset.theme).toBe("paper");
    expect(JSON.parse(localStorage.getItem(THEME_KEY)!)).toMatchObject({
      mode: "fixed",
      theme: "paper",
    });
  });

  /**
   * The regression Liffy's review caught: the polarity buttons unconditionally
   * reseeded from `DEFAULT_SEEDS[polarity]`, and because `onSeeds` is wired to
   * `applyPalette` — which calls `saveCustom` immediately, with no dirty
   * buffer to back out of — pressing the *already selected* polarity silently
   * overwrote and persisted the palette someone was mid-edit on. This presses
   * exactly that button, on the polarity the editor already opens on.
   */
  it("keeps the palette when the already-selected polarity is pressed", async () => {
    const user = userEvent.setup();
    render(<Appearance />);

    await user.click(
      screen.getByRole("button", { name: "Build a custom palette" }),
    );

    const ink = screen.getByRole("textbox", { name: "Ink hex" });
    await user.clear(ink);
    await user.type(ink, "#123456");
    expect(ink).toHaveValue("#123456");

    // The editor opens on Dark (DEFAULT_SEEDS.dark) — pressing it again is
    // the no-op case, not a request to reset.
    await user.click(screen.getByRole("button", { name: "dark" }));

    expect(screen.getByRole("textbox", { name: "Ink hex" })).toHaveValue(
      "#123456",
    );
  });

  /**
   * The other finding: `componentCss` interpolated colours unchecked, and the
   * only caller that validated first was the import path — the live editor's
   * free-text hex field reached the stylesheet with nothing in between. This
   * types the exact shape of payload `appearance.test.ts` proves an imported
   * file cannot get away with, through the editor instead of a file.
   */
  it("does not let an unsafe hex typed into the live editor reach the stylesheet", async () => {
    const user = userEvent.setup();
    render(<Appearance />);

    await user.click(screen.getByRole("button", { name: /⌘K components/ }));
    await user.type(
      screen.getByRole("textbox", { name: "Search components" }),
      "metric",
    );
    await user.keyboard("{Enter}");

    const hex = screen.getByRole("textbox", { name: "Background hex" });
    await user.clear(hex);
    fireEvent.change(hex, {
      target: { value: "#fff;} html{display:none} .x{color:red" },
    });

    const applied = document.getElementById("liffy-appearance")?.textContent ?? "";
    expect(applied).not.toContain("display:none");
    expect(applied).not.toContain('[data-liffy="metric-card"]');
  });
});
