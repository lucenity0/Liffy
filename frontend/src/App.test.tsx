import { render, screen } from "@testing-library/react";
import App from "./App";
import { describe, expect, it } from "vitest";

describe("App", () => {
  it("renders the root text", () => {
    render(<App />);

    expect(screen.getByText(/Liffy Frontend/i)).toBeInTheDocument();
  });
});