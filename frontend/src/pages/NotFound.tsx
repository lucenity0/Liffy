import { useLocation } from "react-router-dom";
import { ButtonLink } from "@/components/ui/Button";
import { LiffyMark } from "@/components/ui/LiffyMark";

export function NotFound() {
  const { pathname } = useLocation();

  return (
    <div className="flex flex-col items-start gap-4 py-16">
      {/* Decorative — "404" and the heading below both already say it. */}
      <LiffyMark className="w-16 opacity-70" />
      <p className="label">404</p>
      <h1 className="font-hand text-2xl leading-tight text-ink">
        Nothing filed here
      </h1>
      <p className="text-ink-dim">
        No page matches <code className="font-code text-ink">{pathname}</code>.
      </p>
      {/* ButtonLink rather than a hand-rolled <Link> wearing button classes:
          the inlined copy drifted from the primitive and stopped picking up
          token changes. */}
      <ButtonLink to="/" className="mt-2">
        Go to dashboard
      </ButtonLink>
    </div>
  );
}
