import { PaperBackdrop } from "@/components/layout/PaperBackdrop";
import { PixelSprite } from "@/components/ui/PixelSprite";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useAuth } from "@/hooks/useAuth";
import { Spinner } from "@/components/ui/Spinner";
import { Navigate } from "react-router-dom";

/**
 * The one screen an anonymous visitor can reach.
 *
 * Rendered outside `AppShell` on purpose: the shell carries the authenticated
 * nav (Dashboard / Reviews tabs, breadcrumbs), and wrapping a login page in
 * navigation to places you cannot go is worse than no chrome at all.
 */

/**
 * A real `<a href>`, not a router `<Link>` or an onClick.
 *
 * Starting OAuth is a full-page navigation to a *different origin* (the API,
 * which then bounces to GitHub). The router cannot express that, and a
 * button-with-onClick would lose middle-click, ctrl-click and "copy link
 * address" for no gain.
 */
function authorizeUrl(): string {
  // Undefined when VITE_API_BASE_URL is unset — in tests, and in any
  // deployment where the API is proxied at the same origin. An empty base
  // leaves a root-relative "/auth/github", which is right in both cases;
  // `apiClient` treats an absent base the same way.
  const base = import.meta.env.VITE_API_BASE_URL ?? "";
  return `${base.replace(/\/$/, "")}/auth/github`;
}

export function Login() {
  useDocumentTitle("Sign in");
  const { status } = useAuth();

  if (status === "loading") {
    return (
      <div
        className="flex min-h-screen items-center justify-center"
        aria-busy="true"
      >
        <Spinner size="md" label="Loading" />
      </div>
    );
  }

  if (status === "authenticated") {
    return <Navigate to="/" replace />;
  }

  return (
    <>
      <PaperBackdrop />

      <main
        id="main"
        className="relative z-1 flex min-h-dvh items-center justify-center px-4 py-12"
      >
        {/* Two columns: what Liffy is on the left, the way in on the right.
            The card alone read as a dialog with no page behind it — the one
            screen an anonymous visitor sees was also the one saying least
            about the product. Stacks below `md`, card first, because on a
            phone the thing you came to press should not be under a pitch. */}
        <div className="grid w-full max-w-3xl items-center gap-10 md:grid-cols-2">
          <section className="order-2 flex flex-col gap-6 md:order-1">
            <div className="flex flex-col gap-2">
              <p className="font-hand text-2xl leading-tight text-ink">
                Code review that has read your codebase.
              </p>
              <p className="max-w-prose text-base text-ink-dim">
                Self-hosted peer review for GitHub pull requests.
              </p>
            </div>

            <div className="border-t-2 border-rule-strong" />

            <ul className="flex flex-col gap-4">
              {CAPABILITIES.map((item) => (
                <li key={item.label} className="flex flex-col gap-0.5">
                  <span className="label text-ink">{item.label}</span>
                  <span className="text-sm text-ink-dim">{item.detail}</span>
                </li>
              ))}
            </ul>
          </section>

          <div className="order-1 flex flex-col gap-4 md:order-2">
            <IllustrationSlot />

            <div className="rounded-sheet w-full border border-rule bg-card px-6 py-8 shadow-hard">
              <h1 className="font-hand text-2xl leading-none text-ink">
                Liffy
              </h1>
              <p className="mt-2 text-base text-ink-dim">
                Connect GitHub to get started.
              </p>

              <a
                href={authorizeUrl()}
                className="rounded-chip mt-6 inline-flex w-full items-center justify-center gap-2 border border-ink bg-ink px-3.5 py-1.5 text-base text-paper no-underline shadow-hard transition-colors duration-100 hover:border-ink-dim hover:bg-ink-dim"
              >
                {/* Decorative: the adjacent text already names the action, so a
                labelled icon would make a screen reader say it twice. */}
                <svg
                  aria-hidden="true"
                  viewBox="0 0 16 16"
                  className="size-4 fill-current"
                >
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
                </svg>
                Continue with GitHub
              </a>

              <p className="label mt-4">
                Liffy only reads the repositories you grant access to. You can
                revoke it from your GitHub settings at any time.
              </p>
            </div>
          </div>
        </div>
      </main>
    </>
  );
}

const CAPABILITIES = [
  {
    label: "Reviews",
    detail: "Every pull request, read in context rather than in isolation.",
  },
  {
    label: "Repository aware",
    detail: "Retrieval over your indexed codebase, not just the diff.",
  },
  {
    label: "Self-hosted",
    detail: "Your infrastructure, your model keys, your code.",
  },
];

/**
 * PLACEHOLDER — swap for the real artwork when it lands.
 *
 * To replace: drop the asset in `public/`, then return an <img> here with a
 * meaningful `alt` (or `alt=""` if the surrounding copy already says it) and
 * delete everything below. Nothing else on the page reads this component, and
 * the layout already reserves the space, so the swap is local.
 *
 * Until then it is the pixel cat on a ruled panel rather than a grey box with
 * "image" written in it — an empty frame on the first screen anyone sees
 * reads as broken, and this at least reads as Liffy.
 */
function IllustrationSlot() {
  return (
    <div
      data-placeholder="login-illustration"
      className="rounded-sheet flex aspect-[3/2] items-center justify-center border border-dashed border-rule-strong bg-recessed"
    >
      <PixelSprite name="cat" cell={5} className="text-ink-sub" />
    </div>
  );
}
