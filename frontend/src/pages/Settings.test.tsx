import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { server } from "@/mocks/server";
import { fixtureSettings } from "@/mocks/fixtures";
import { setDotenvSecret } from "@/mocks/handlers";
import { renderWithProviders } from "@/test/renderWithProviders";
import { Settings } from "./Settings";

const renderPage = () => renderWithProviders(<Settings />, { route: "/settings" });

/** The row a setting's label belongs to, so assertions stay scoped to it. */
const rowFor = (label: RegExp | string) =>
  screen.getByText(label).closest("div")!.parentElement!;

describe("Settings", () => {
  it("renders editable settings as controls, grouped", async () => {
    renderPage();

    // A choice is a dropdown carrying exactly the options the API allows.
    const effort = await screen.findByLabelText("Thinking effort");
    expect(effort.tagName).toBe("SELECT");
    expect(
      [...(effort as HTMLSelectElement).options].map((o) => o.value),
    ).toEqual(["low", "medium", "high", "xhigh", "max"]);

    // A bool is a checkbox, an int is a text box.
    expect(screen.getByLabelText(/post reviews to github/i)).toHaveAttribute(
      "type",
      "checkbox",
    );
    expect(screen.getByLabelText("Max tokens")).toHaveValue("24000");
  });

  it("says where each value came from", async () => {
    renderPage();
    await screen.findByLabelText("Thinking effort");

    // The marker that makes this a settings page rather than a form.
    expect(within(rowFor("Thinking effort")).getByText("Changed here")).toBeInTheDocument();
    expect(within(rowFor("Max tokens")).getByText("Set in .env")).toBeInTheDocument();
    expect(within(rowFor("Provider")).getByText("Default")).toBeInTheDocument();
    // And what it was changed *from*. Matched as the whole "default medium"
    // phrase, because "medium" on its own is also one of the dropdown's
    // options — the provenance line is the claim being made here.
    expect(rowFor("Thinking effort")).toHaveTextContent(/default\s*medium/);
    // Not shown where the value is already the default: repeating a value
    // beside itself is noise.
    expect(rowFor("Provider")).not.toHaveTextContent(/default\s*anthropic/);
  });

  it("renders read-only settings as disabled, with a reason", async () => {
    renderPage();

    const control = await screen.findByLabelText("Database URL");
    expect(control).toBeDisabled();
    // A greyed-out box with no explanation reads as broken rather than
    // deliberate, so the reason is part of the contract.
    expect(
      screen.getByText(/engine is built at import/i),
    ).toBeInTheDocument();
  });

  it("shows secrets as configured or not, and never as a value", async () => {
    renderPage();
    await screen.findByLabelText("Thinking effort");

    // "From .env", not "Configured": the badge names *where* the value lives,
    // which is the question this page exists to answer — and the one that
    // decides whether Disconnect can do anything.
    expect(screen.getAllByText("From .env").length).toBeGreaterThan(0);
    // The fixture's selected provider has its key set, so nothing is in the
    // "needs configuring" state — the unset keys belong to other providers.
    // That split is asserted on its own further down.
    expect(screen.getAllByText("Not configured").length).toBeGreaterThan(0);
    expect(screen.queryByText("Needs configuring")).toBeNull();

    // No input for a secret under any label — not even a disabled or masked
    // one. A mask still discloses the length.
    expect(screen.queryByLabelText(/api key/i)).toBeNull();
    expect(document.body.textContent).not.toMatch(/•{3,}|\*{3,}/);
  });

  it("requires confirmation before enabling GitHub posting", async () => {
    const user = userEvent.setup();
    renderPage();

    const toggle = await screen.findByLabelText(/post reviews to github/i);
    await user.click(toggle);

    const dialog = await screen.findByRole("dialog");
    // The copy has to state plainly what happens outside Liffy.
    expect(dialog).toHaveTextContent(/real pull requests/i);

    // Cancelling leaves the setting alone and stages nothing to save.
    await user.click(within(dialog).getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByLabelText(/post reviews to github/i)).not.toBeChecked();
    expect(screen.getByRole("button", { name: /save changes/i })).toBeDisabled();
  });

  it("applies the change once the confirmation is accepted", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByLabelText(/post reviews to github/i));
    await user.click(
      await screen.findByRole("button", { name: /turn it on/i }),
    );

    await waitFor(() =>
      expect(screen.getByLabelText(/post reviews to github/i)).toBeChecked(),
    );
  });

  it("does not confirm when turning a dangerous setting back off", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/settings", () =>
        HttpResponse.json({
          ...fixtureSettings,
          editable: fixtureSettings.editable.map((s) =>
            s.key === "post_reviews_to_github"
              ? { ...s, value: true, source: "override" as const }
              : s,
          ),
        }),
      ),
    );

    renderPage();
    const toggle = await screen.findByLabelText(/post reviews to github/i);
    await waitFor(() => expect(toggle).toBeChecked());

    await user.click(toggle);

    // Confirming a retreat to the safe state would only train people to
    // dismiss the dialog, which is what makes it useless when it matters.
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(toggle).not.toBeChecked());
  });

  it("saves only what was touched", async () => {
    const user = userEvent.setup();
    let sent: Record<string, string> | null = null;
    server.use(
      http.patch("*/settings", async ({ request }) => {
        sent = ((await request.json()) as { values: Record<string, string> }).values;
        return HttpResponse.json(fixtureSettings);
      }),
    );

    renderPage();
    await user.selectOptions(
      await screen.findByLabelText("Thinking effort"),
      "low",
    );
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    // Not every editable key — sending untouched settings would overwrite a
    // value somebody changed in another tab.
    await waitFor(() => expect(sent).toEqual({ anthropic_effort: "low" }));
  });

  // ── One model field, chosen by the provider ─────────────────────────────
  //
  // The page used to render a separate model box per provider — three of which
  // did nothing for whichever one you had selected, and none at all for codex.

  it("shows only the selected provider's model field", async () => {
    renderPage();

    // Provider is `anthropic` in the fixture.
    const model = await screen.findByLabelText("Model");
    expect([...(model as HTMLSelectElement).options].map((o) => o.value)).toEqual(
      ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "__custom__"],
    );
    // Anthropic-only settings come along for the ride.
    expect(screen.getByLabelText("Thinking effort")).toBeInTheDocument();
  });

  it("swaps the model field when the provider changes, before saving", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.selectOptions(
      await screen.findByLabelText("Provider"),
      "openai",
    );

    // Waiting for a save would mean picking the provider and the model in two
    // separate round trips.
    await waitFor(() =>
      expect(screen.queryByLabelText("Thinking effort")).not.toBeInTheDocument(),
    );
    // openai_model's fixture value is outside its suggestion list, so the row
    // opens on the custom input rather than silently showing a wrong model.
    expect(screen.getByLabelText("Model (custom)")).toHaveValue("llama3.3:70b");
  });

  it("offers suggestions without closing the field", async () => {
    const user = userEvent.setup();
    let sent: Record<string, string> | null = null;
    server.use(
      http.patch("*/settings", async ({ request }) => {
        sent = ((await request.json()) as { values: Record<string, string> }).values;
        return HttpResponse.json(fixtureSettings);
      }),
    );

    renderPage();
    await user.selectOptions(await screen.findByLabelText("Model"), "__custom__");
    const custom = screen.getByLabelText("Model (custom)");
    await user.clear(custom);
    await user.type(custom, "claude-opus-4-8");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    // A name outside the list still saves — `openai` also drives Ollama and
    // Gemini, where a closed list would lock out the valid answer.
    await waitFor(() =>
      expect(sent).toEqual({ anthropic_model: "claude-opus-4-8" }),
    );
  });

  it("does not dress an irrelevant unset secret as a problem", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByLabelText("Provider");

    // Provider is `anthropic`, so the Claude Code token is genuinely not
    // needed — and on a host install it is empty for everyone.
    const token = rowFor("Claude Code OAuth token");
    expect(within(token).getByText("Not configured")).toBeInTheDocument();
    expect(token).toHaveTextContent(/not used by the selected provider/i);

    // The one the review actually depends on is called out instead.
    expect(
      within(rowFor("OpenAI API key")).getByText("Not configured"),
    ).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Provider"), "openai");

    await waitFor(() =>
      expect(
        within(rowFor("OpenAI API key")).getByText("Needs configuring"),
      ).toBeInTheDocument(),
    );
  });

  // ── Connecting an account from the page ─────────────────────────────────
  //
  // The page's whole premise is that nobody should have to find the right line
  // in a dotfile. Selecting `claude_code` used to break that premise
  // immediately, by telling you to go and edit one.

  it("connects the subscription token without leaving the page", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByLabelText("Provider");

    const row = rowFor("Claude Code OAuth token");
    await user.click(within(row).getByRole("button", { name: /connect/i }));

    // The command is shown because Liffy cannot run it — the CLI's login is a
    // browser flow with no headless mode.
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("claude setup-token");

    await user.type(
      within(dialog).getByLabelText(/value/i),
      "sk-ant-oat01-aaaaaaaaaaaaaaaaaaaaaaaa",
    );
    await user.click(within(dialog).getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(
        within(rowFor("Claude Code OAuth token")).getByText("Connected"),
      ).toBeInTheDocument(),
    );
    // Never echoed back, in either direction.
    expect(document.body.textContent).not.toContain("sk-ant-oat01");
  });

  it("offers Replace, not Disconnect, for a token that came from .env", async () => {
    /**
     * The bug this pins, hit in a real session.
     *
     * Disconnect had already worked — the stored row was gone — but the token
     * in `backend/.env` took over, so the row still read as set and the page
     * still showed Disconnect. Pressing it deleted a row that was not there and
     * re-rendered identically, so the button looked dead. There was also no way
     * back: Connect only appeared when nothing was set, so a dotfile token
     * could not be replaced from the page at all.
     */
    const user = userEvent.setup();
    setDotenvSecret("claude_code_oauth_token");
    renderPage();
    await screen.findByLabelText("Provider");

    const row = rowFor("Claude Code OAuth token");
    await user.click(within(row).getByRole("button", { name: "Connect" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(
      within(dialog).getByLabelText(/value/i),
      "sk-ant-oat01-aaaaaaaaaaaaaaaaaaaaaaaa",
    );
    await user.click(within(dialog).getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(
        within(rowFor("Claude Code OAuth token")).getByText("Connected"),
      ).toBeInTheDocument(),
    );

    // Disconnect gives the dotfile's value back — still set, but no longer ours.
    await user.click(
      within(rowFor("Claude Code OAuth token")).getByRole("button", {
        name: "Disconnect",
      }),
    );

    const after = await waitFor(() => {
      const r = rowFor("Claude Code OAuth token");
      expect(within(r).getByText("From .env")).toBeInTheDocument();
      return r;
    });
    // The button that could only ever no-op is gone, and the way back is not.
    expect(
      within(after).queryByRole("button", { name: "Disconnect" }),
    ).toBeNull();
    expect(
      within(after).getByRole("button", { name: "Replace" }),
    ).toBeInTheDocument();
  });

  it("keeps a rejected token on the dialog instead of claiming success", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByLabelText("Provider");

    await user.click(
      within(rowFor("Claude Code OAuth token")).getByRole("button", {
        name: /connect/i,
      }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/value/i), "too-short");
    await user.click(within(dialog).getByRole("button", { name: "Connect" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      /does not look like a token/i,
    );
    // A green badge for a token that never worked is the failure this replaces.
    expect(
      within(rowFor("Claude Code OAuth token")).getByText("Not configured"),
    ).toBeInTheDocument();
  });

  it("offers no connect action for credentials the page may not set", async () => {
    renderPage();
    await screen.findByLabelText("Provider");

    // `jwt_secret_key` signs sessions and `github_token` belongs to an
    // account; a settings page able to write either would be a hole.
    for (const label of ["GitHub token", "Anthropic API key"]) {
      expect(
        within(rowFor(label)).queryByRole("button", { name: /connect/i }),
      ).toBeNull();
    }
  });

  it("confirms before pointing the reviewer at a different endpoint", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.selectOptions(
      await screen.findByLabelText("Provider"),
      "openai",
    );
    await user.selectOptions(
      await screen.findByLabelText("Endpoint"),
      "http://localhost:11434/v1",
    );

    // Changing where the diff is sent is a decision about who sees the code.
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/your code leaves this machine/i);
  });

  it("surfaces a validation error on the field, not as a page crash", async () => {
    const user = userEvent.setup();
    server.use(
      http.patch("*/settings", () =>
        HttpResponse.json({ detail: "Must be at least 4000." }, { status: 422 }),
      ),
    );

    renderPage();
    const tokens = await screen.findByLabelText("Max tokens");
    await user.clear(tokens);
    await user.type(tokens, "500");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent(/at least 4000/i);
    // The page is still a page: the other controls survived.
    expect(screen.getByLabelText("Thinking effort")).toBeInTheDocument();
    expect(tokens).toHaveAttribute("aria-invalid", "true");
  });

  it("keeps Save disabled until something changes", async () => {
    const user = userEvent.setup();
    renderPage();

    const save = await screen.findByRole("button", { name: /save changes/i });
    expect(save).toBeDisabled();

    await user.selectOptions(screen.getByLabelText("Provider"), "openai");

    expect(save).toBeEnabled();
    expect(screen.getByText("Unsaved")).toBeInTheDocument();
  });

  it("surfaces a failed load with a retry", async () => {
    server.use(
      http.get("*/settings", () =>
        HttpResponse.json({ detail: "boom" }, { status: 500 }),
      ),
    );

    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });
});
