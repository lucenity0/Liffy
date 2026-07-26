import { isRouteErrorResponse, Link, useRouteError } from "react-router-dom";
import { PaperBackdrop } from "./PaperBackdrop";

/**
 * The data router's `errorElement`. It renders *outside* the shell's Outlet
 * — a thrown loader or render error may well have come from the shell itself
 * — so it repaints its own backdrop rather than assuming one is there.
 */
export function RouteError() {
  const error = useRouteError();

  const { heading, detail } = isRouteErrorResponse(error)
    ? {
        heading: `${error.status}`,
        detail: error.statusText || "That page could not be loaded.",
      }
    : {
        heading: "Something broke",
        detail:
          error instanceof Error
            ? error.message
            : "An unexpected error stopped this page from rendering.",
      };

  return (
    <>
      <PaperBackdrop />
      <div className="relative z-1 mx-auto flex min-h-screen max-w-prose flex-col items-start justify-center gap-4 px-6">
        <p className="label">Liffy</p>
        <h1 className="font-hand text-2xl leading-tight text-ink">{heading}</h1>
        <p className="text-ink-dim">{detail}</p>
        <div className="flex gap-3 pt-2">
          <Link
            to="/"
            className="border border-rule bg-card px-3 py-1.5 text-sm text-ink shadow-hard hover:border-rule-strong"
          >
            Go to dashboard
          </Link>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="border border-rule px-3 py-1.5 text-sm text-ink-dim hover:border-rule-strong hover:text-ink"
          >
            Reload
          </button>
        </div>
      </div>
    </>
  );
}
