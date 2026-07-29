import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PaperBackdrop } from "@/components/layout/PaperBackdrop";
import { Spinner } from "@/components/ui/Spinner";
import { useAuth } from "@/hooks/useAuth";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { takeReturnTo } from "@/lib/returnTo";
import type { TokenPair } from "@/types/api";

/**
 * Where the backend hands the browser back after the GitHub round trip.
 *
 * The token pair arrives in the URL *fragment* — `#access_token=…` — because
 * a fragment is never sent to a server, so the tokens stay out of access
 * logs, `Referer` headers and any proxy in between. A query string would not.
 */

/**
 * Every failure the callback can carry, in the user's language.
 *
 * `access_denied` is first because it is not really a failure: it is what
 * GitHub sends when someone presses Cancel on the consent screen. Treating
 * that as an exception — and landing them on a blank white page — is the
 * most common way to ship this half-done.
 */
const ERROR_COPY: Record<string, string> = {
  access_denied: "You cancelled the GitHub sign-in. Nothing was shared.",
  state_mismatch:
    "That sign-in link didn't match this browser session. Start again from the beginning.",
  missing_code_or_state: "GitHub's response was incomplete. Please try again.",
  missing_tokens: "The sign-in response was missing its tokens. Please try again.",
  github_exchange_failed: "GitHub wouldn't complete the sign-in. Please try again.",
  session_failed: "Signed in, but your account couldn't be loaded. Please try again.",
};

function messageFor(code: string): string {
  return ERROR_COPY[code] ?? "Something went wrong signing you in. Please try again.";
}

type Outcome =
  | { kind: "tokens"; pair: TokenPair }
  | { kind: "error"; code: string };

/**
 * Read the fragment. Deliberately pure — it never mutates the URL, so calling
 * it twice yields the same answer. That is what makes it safe to run during
 * render, where StrictMode invokes it twice in development.
 */
function parseFragment(): Outcome {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));

  const failure = params.get("error");
  if (failure) return { kind: "error", code: failure };

  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");
  if (!accessToken || !refreshToken) {
    return { kind: "error", code: "missing_tokens" };
  }

  return {
    kind: "tokens",
    pair: {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "bearer",
      expires_in: Number(params.get("expires_in") ?? 0),
    },
  };
}

export function AuthCallback() {
  useDocumentTitle("Signing in");
  const navigate = useNavigate();
  const { login } = useAuth();

  /**
   * Parsed during render rather than in an effect.
   *
   * The fragment is already in the URL before React mounts, so this is
   * derived state, not a synchronization side effect — and reading it here
   * means the "did it carry an error?" answer is available on the very first
   * paint instead of one render later.
   */
  const [outcome] = useState(parseFragment);
  const [error, setError] = useState<string | null>(
    outcome.kind === "error" ? outcome.code : null,
  );

  /** Erasing the fragment and spending the tokens must happen exactly once. */
  const consumed = useRef(false);

  useEffect(() => {
    if (consumed.current) return;
    consumed.current = true;

    // Tokens left in the address bar end up in a bookmark, a screenshot, or
    // the next person to look at the screen.
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );

    if (outcome.kind !== "tokens") return;

    login(outcome.pair)
      .then(() => {
        // `replace` so the back button does not return to this page, whose
        // fragment is now gone and which would fail on a second read.
        navigate(takeReturnTo(), { replace: true });
      })
      .catch(() => setError("session_failed"));
  }, [outcome, login, navigate]);

  return (
    <>
      <PaperBackdrop />

      <main
        id="main"
        className="relative z-1 flex min-h-screen items-center justify-center px-4 py-12"
      >
        {error === null ? (
          <div className="flex items-center gap-3">
            <Spinner size="md" label="Signing you in" />
            <p className="text-base text-ink-dim">Signing you in…</p>
          </div>
        ) : (
          <div
            role="alert"
            className="rounded-sheet w-full max-w-sm border border-rule bg-card px-6 py-8 shadow-hard"
          >
            <h1 className="font-hand text-2xl leading-none text-ink">
              Couldn't sign you in
            </h1>
            <p className="mt-3 text-base text-ink-dim">{messageFor(error)}</p>
            <Link
              to="/login"
              replace
              className="rounded-chip mt-6 inline-flex items-center justify-center border border-rule bg-card px-3.5 py-1.5 text-base text-ink no-underline shadow-hard transition-colors duration-100 hover:border-rule-strong hover:bg-recessed"
            >
              Back to sign in
            </Link>
          </div>
        )}
      </main>
    </>
  );
}
