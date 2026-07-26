import { Link, useLocation } from "react-router-dom";

export function NotFound() {
  const { pathname } = useLocation();

  return (
    <div className="flex flex-col items-start gap-4 py-16">
      <p className="label">404</p>
      <h1 className="font-hand text-2xl leading-tight text-ink">
        Nothing filed here
      </h1>
      <p className="text-ink-dim">
        No page matches <code className="font-code text-ink">{pathname}</code>.
      </p>
      <Link
        to="/"
        className="mt-2 border border-rule bg-card px-3 py-1.5 text-sm text-ink shadow-hard hover:border-rule-strong"
      >
        Go to dashboard
      </Link>
    </div>
  );
}
