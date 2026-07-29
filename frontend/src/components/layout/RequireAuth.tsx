import { Navigate, Outlet, useLocation } from "react-router-dom";
import { Spinner } from "@/components/ui/Spinner";
import { useAuth } from "@/hooks/useAuth";
import { stashReturnTo } from "@/lib/returnTo";

/**
 * The gate in front of every authenticated surface.
 *
 * Three branches, one per `AuthContext` status — which is the whole reason
 * that status is not a boolean. `loading` renders a splash and **does not
 * redirect**: bouncing to `/login` while the session is still rehydrating is
 * exactly what makes the login page flash on every refresh, and it is why a
 * boolean `isAuthenticated` cannot express this correctly.
 */
export function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === "loading") {
    return (
      <div
        className="flex min-h-screen items-center justify-center"
        // Not `role="alert"` — this is routine, not an error, and a screen
        // reader should hear it politely or not at all.
        aria-busy="true"
      >
        <Spinner size="md" label="Loading" />
      </div>
    );
  }

  if (status === "anonymous") {
    // Remember where they were headed so AUTH-7's callback can put them back
    // there. Someone deep-linking to a review should land on that review
    // after signing in, not on the dashboard having lost their place.
    //
    // The hash is part of the destination, not decoration: review comments
    // render `id={commentAnchorId(comment.id)}`, so `#comment-<uuid>`
    // addresses a real element. A link pasted into Slack that points at one
    // specific comment is precisely what this exists to preserve.
    stashReturnTo(location.pathname + location.search + location.hash);

    // `replace`, not a push: without it the back button bounces between the
    // guarded page and /login, and the user cannot escape either way.
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
