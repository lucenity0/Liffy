import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPEARANCE_CSS_KEY,
  APPEARANCE_KEY,
  applyAppearance,
  readAppearance,
  useAppearance,
} from "./useAppearance";
import { DEFAULT_APPEARANCE } from "@/lib/theme/appearance";

/**
 * The workspace half of the theme, and the two things it has to get right:
 * a change is visible immediately in this tab, and it reaches the others.
 */

const style = () => document.getElementById("liffy-appearance");

beforeEach(() => {
  localStorage.clear();
  style()?.remove();
  const root = document.documentElement;
  for (const name of ["data-motion", "data-shadow", "data-nav"]) {
    root.removeAttribute(name);
  }
});

describe("applyAppearance", () => {
  it("writes one <style> and reuses it rather than stacking rules", () => {
    applyAppearance(DEFAULT_APPEARANCE);
    applyAppearance({ ...DEFAULT_APPEARANCE, scale: 1.1 });

    expect(document.querySelectorAll("#liffy-appearance")).toHaveLength(1);
    expect(style()?.textContent).toContain("--ui-scale:1.1");
    expect(style()?.textContent).not.toContain("--ui-scale:1;");
  });

  it("sets the attributes index.css keys its motion and shadow rules off", () => {
    applyAppearance({ ...DEFAULT_APPEARANCE, motion: "off", shadow: "none", nav: "compact" });

    const root = document.documentElement;
    expect(root.getAttribute("data-motion")).toBe("off");
    expect(root.getAttribute("data-shadow")).toBe("none");
    expect(root.getAttribute("data-nav")).toBe("compact");
  });

  /**
   * The cache the boot script reads. Without it the first paint of the next
   * load is at the default scale and every page reflows once — the exact
   * flash the pre-paint script exists to prevent, moved from colour to size.
   */
  it("caches the resolved stylesheet for the next first paint", () => {
    applyAppearance({ ...DEFAULT_APPEARANCE, radius: 8 });

    const cached = localStorage.getItem(APPEARANCE_CSS_KEY);
    expect(cached).toBe(style()?.textContent);
    expect(cached).toContain("--ui-radius:8px");
  });

  it("still applies when storage is blocked", () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("storage is blocked");
      });

    applyAppearance({ ...DEFAULT_APPEARANCE, scale: 0.9 });
    expect(style()?.textContent).toContain("--ui-scale:0.9");

    setItem.mockRestore();
  });
});

describe("readAppearance", () => {
  it("falls back to the defaults for a store holding nonsense", () => {
    localStorage.setItem(APPEARANCE_KEY, "{not json");
    expect(readAppearance()).toEqual(DEFAULT_APPEARANCE);
  });
});

describe("useAppearance", () => {
  it("applies a change immediately, without a save step", () => {
    const { result } = renderHook(() => useAppearance());

    act(() => result.current.update({ scale: 1.15 }));

    expect(result.current.config.scale).toBe(1.15);
    expect(style()?.textContent).toContain("--ui-scale:1.15");
  });

  it("keeps the fields it was not asked to change", () => {
    const { result } = renderHook(() => useAppearance());

    act(() => result.current.update({ scale: 1.1 }));
    act(() => result.current.update({ nav: "compact" }));

    expect(result.current.config.scale).toBe(1.1);
    expect(result.current.config.nav).toBe("compact");
  });

  it("notifies every subscriber, not only the one that changed it", () => {
    const first = renderHook(() => useAppearance());
    const second = renderHook(() => useAppearance());

    act(() => first.result.current.update({ density: 0.88 }));

    expect(second.result.current.config.density).toBe(0.88);
  });

  it("resets to the defaults, which is what undo means here", () => {
    const { result } = renderHook(() => useAppearance());

    act(() => result.current.update({ scale: 1.2, radius: 8, motion: "off" }));
    act(() => result.current.reset());

    expect(result.current.config).toEqual(DEFAULT_APPEARANCE);
    expect(document.documentElement.getAttribute("data-motion")).toBe("full");
  });

  it("follows a change made in another tab", () => {
    const { result } = renderHook(() => useAppearance());

    localStorage.setItem(
      APPEARANCE_KEY,
      JSON.stringify({ ...DEFAULT_APPEARANCE, scale: 0.8, nav: "compact" }),
    );
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: APPEARANCE_KEY }));
    });

    expect(result.current.config.scale).toBe(0.8);
    expect(style()?.textContent).toContain("--ui-scale:0.8");
    expect(document.documentElement.getAttribute("data-nav")).toBe("compact");
  });

  it("ignores an unrelated key", () => {
    const { result } = renderHook(() => useAppearance());
    act(() => result.current.update({ scale: 1.1 }));

    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "liffy-theme" }));
    });

    expect(result.current.config.scale).toBe(1.1);
  });
});
