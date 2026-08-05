import { PaperBackdrop } from "@/components/layout/PaperBackdrop";
import { CafeScene } from "@/components/ui/CafeScene";
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

      {/* A sheet, the same device the landing page and the under-construction
          page use, and for the same reason: graph paper is a good page
          texture and a terrible backing for words. The grid keeps the
          margins, everything with words in it gets a solid surface.

          Without one this screen was a paragraph and two panels adrift on
          the grid — every element floating at its own elevation with nothing
          holding them together. It is the one page an anonymous visitor
          sees, and it was the least composed one in the product.

          Side rules only where there is margin left to show grid in: below
          the sheet's own width they would be two stray lines against the
          screen edge. */}
      <div className="relative z-1 mx-auto flex min-h-dvh max-w-5xl flex-col justify-center border-x border-rule bg-paper px-5 py-12 max-lg:border-x-0 sm:px-10">
        <main id="main" className="w-full">
          {/* A head, so the page opens the way the front door does: the
              status line, the wordmark, then the claim. */}
          <header className="flex flex-col gap-3">
            <p className="label flex items-center gap-2.5">
              <span aria-hidden="true" className="size-1.5 shrink-0 bg-sage" />
              self-hosted &middot; ai code review
            </p>
            {/* text-2xl is the top of the app's scale — the landing page's
                7rem wordmark has no rung here, and adding one for a single
                screen would be a design system grown to fit a page. So the
                wordmark takes the largest size there is and the claim steps
                down to xl, which puts the hierarchy back without inventing
                anything. */}
            <h1 className="font-hand text-2xl leading-none font-semibold text-ink">
              Liffy
            </h1>
            <p className="font-hand max-w-prose text-xl leading-snug text-ink">
              Code review that has read your codebase.{" "}
              <span className="text-ink-dim">Not the file. The codebase.</span>
            </p>
          </header>

          <div className="my-8 border-t border-rule" />

          {/* Two columns: everything Liffy has to say on the left, the
              picture on the right. The card used to sit under the picture,
              which left a hole under the capability list and made the two
              columns end at different heights; moving it down the left
              column fills that hole, and stretching the picture to match
              closes the page.

              Stacks below `md`, picture and card first, because on a phone
              the thing you came to press should not be under a pitch. */}
          <div className="grid w-full items-stretch gap-x-10 gap-y-8 md:grid-cols-2">
            <section className="order-2 flex flex-col md:order-1">
              <ul className="flex flex-col">
                {CAPABILITIES.map((item) => (
                  <li
                    key={item.label}
                    className="flex flex-col gap-0.5 border-t border-rule py-4 first:border-t-0 first:pt-0"
                  >
                    <span className="label text-ink">{item.label}</span>
                    <span className="text-sm text-ink-dim">{item.detail}</span>
                  </li>
                ))}
              </ul>

              {/* mt-auto, so the card lands on the bottom edge of the column
                  whatever the list above it measures. */}
              <div className="rounded-sheet mt-auto w-full border border-rule bg-card px-6 py-6 shadow-hard">
                <p className="text-base text-ink">
                  Connect GitHub to get started.
                </p>

                <a
                  href={authorizeUrl()}
                  className="rounded-chip mt-5 inline-flex w-full items-center justify-center gap-2 border border-ink bg-ink px-3.5 py-1.5 text-base text-paper no-underline shadow-hard transition-colors duration-100 hover:border-ink-dim hover:bg-ink-dim"
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
            </section>

            {/* No aspect-ratio: the scene fills the column, and the room
                grows wall to whatever height the left column settled on.
                Below `md` there is no column to match, so it goes back to
                its own proportions. */}
            <CafeScene className="order-1 max-md:aspect-[320/232] md:order-2 md:aspect-auto md:h-full" />
          </div>

          {/* A foot, so the sheet closes rather than stopping. */}
          <div className="mt-8 border-t border-rule pt-4">
            <p className="label">
              liffy &middot; your repos, your keys, your machine
            </p>
          </div>
        </main>
      </div>
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
