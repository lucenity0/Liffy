import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { server } from "@/mocks/server";
import { fixtureLatestFinding } from "@/mocks/fixtures";
import { renderWithProviders } from "@/test/renderWithProviders";
import { LatestFinding } from "./LatestFinding";

function respondWith(body: unknown, status = 200) {
  server.use(
    http.get("*/reviews/latest-finding", () =>
      HttpResponse.json(body as never, { status }),
    ),
  );
}

describe("LatestFinding", () => {
  it("shows the finding's own words, not a summary of them", async () => {
    renderWithProviders(<LatestFinding />);

    expect(
      await screen.findByText(/allows omitting it \(defaults to 1\)/),
    ).toBeInTheDocument();
  });

  it("anchors the finding to its file and line range", async () => {
    renderWithProviders(<LatestFinding />);

    expect(await screen.findByText("src/lib/diff.ts:42–44")).toBeInTheDocument();
  });

  it("collapses a single-line range rather than printing 42–42", async () => {
    respondWith({
      ...fixtureLatestFinding,
      comment: {
        ...fixtureLatestFinding.comment,
        line_start: 42,
        line_end: 42,
      },
    });
    renderWithProviders(<LatestFinding />);

    expect(await screen.findByText("src/lib/diff.ts:42")).toBeInTheDocument();
  });

  it("links to the comment's anchor on the review page, not just the review", async () => {
    renderWithProviders(<LatestFinding />);

    const link = await screen.findByRole("link", {
      name: "lucenity0/Liffy #42",
    });
    expect(link).toHaveAttribute(
      "href",
      expect.stringContaining(`/reviews/${fixtureLatestFinding.review_id}#`),
    );
  });

  it("renders nothing at all when there is no finding yet", async () => {
    respondWith(null);
    const { container } = renderWithProviders(<LatestFinding />);

    // Waited on rather than asserted immediately: an empty container is also
    // what the loading state looks like, so without this the test passes
    // before the request has even resolved.
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("stays silent when the request fails", async () => {
    respondWith({ detail: "boom" }, 500);
    const { container } = renderWithProviders(<LatestFinding />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
