import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Login } from "./Login";

/**
 * No router or providers: the page is deliberately free of both, because it
 * renders outside `AppShell` and must work before a session exists.
 */

describe("Login", () => {
  it("renders the continue-with-github action", () => {
    render(<Login />);
    expect(
      screen.getByRole("link", { name: "Continue with GitHub" }),
    ).toBeInTheDocument();
  });

  it("points at the backend authorize URL", () => {
    render(<Login />);
    // VITE_API_BASE_URL is unset in tests, which is the same situation as a
    // same-origin proxy deployment: the base collapses and the path stays
    // root-relative.
    const base = import.meta.env.VITE_API_BASE_URL ?? "";
    expect(screen.getByRole("link", { name: "Continue with GitHub" })).toHaveAttribute(
      "href",
      `${base}/auth/github`,
    );
  });

  it("uses a real link, so OAuth starts as a full-page navigation", () => {
    render(<Login />);
    const action = screen.getByRole("link", { name: "Continue with GitHub" });

    // A <button onClick> here would lose middle-click and ctrl-click, and the
    // router cannot express a navigation to another origin at all.
    expect(action.tagName).toBe("A");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("has one first-level heading and no unlabelled controls", () => {
    render(<Login />);

    // The codebase's accessibility convention is structural assertions like
    // these rather than an axe pass — there is no axe dependency, and adding
    // one is out of scope for this issue.
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Liffy");
    for (const link of screen.getAllByRole("link")) {
      expect(link).toHaveAccessibleName();
    }
  });

  it("marks the github glyph decorative so it is not announced twice", () => {
    const { container } = render(<Login />);
    const icon = container.querySelector("svg");
    expect(icon).toHaveAttribute("aria-hidden", "true");
  });
});
