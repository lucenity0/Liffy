import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { clearReturnTo } from "@/lib/returnTo";
import type { UserOut } from "@/types/api";

/**
 * Who you are signed in as, and the way out — as two rail rows.
 *
 * This used to be a disclosure: a trigger in the chrome that opened a panel
 * holding the same two things. In a top bar that was fine. At the bottom of a
 * full-height rail it was not — the panel opened downward from the last row
 * on screen, so "Log out" rendered past the viewport edge and, once the rail
 * gained its own scroll container, was clipped outright. There was no way to
 * sign out at all.
 *
 * Flattening it fixes the class of bug rather than the instance: no popover
 * means no placement to get wrong, no focus to trap and return, no outside-
 * click to listen for. The nav is already a column of rows, and these are two
 * more of them.
 */

/**
 * `avatar_url` is nullable on GitHub's side, so a missing image must not
 * leave a hole in the chrome. Initials from the username, which always
 * exists.
 */
function initialsOf(username: string): string {
  const parts = username.split(/[-_.\s]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function Avatar({ user }: { user: UserOut }) {
  const [broken, setBroken] = useState(false);

  // A URL that 404s is the same problem as no URL at all, so both land on
  // the initials rather than on a broken-image glyph.
  if (!user.avatar_url || broken) {
    return (
      <span
        aria-hidden="true"
        data-testid="avatar-initials"
        className="flex size-5 shrink-0 items-center justify-center rounded-full border border-rule bg-recessed text-2xs text-ink-dim"
      >
        {initialsOf(user.username)}
      </span>
    );
  }

  return (
    <img
      src={user.avatar_url}
      alt=""
      aria-hidden="true"
      onError={() => setBroken(true)}
      className="size-5 shrink-0 rounded-full border border-rule object-cover"
    />
  );
}

export function UserMenu() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  if (!user) return null;

  async function onLogout() {
    // `logout` never rejects: it clears local state even when the revoke call
    // fails, so a user who clicks Sign out always ends up signed out.
    await logout();

    // After the await, not before. `logout()` flips the status to anonymous,
    // which re-renders `RequireAuth`, which stashes the current path — so the
    // value being discarded here does not exist until that render has run.
    //
    // Only this call site can make the distinction: the guard stashes on
    // every anonymous render and cannot tell "signed out on purpose" from
    // "session expired", and expiry genuinely should return you to where you
    // were.
    clearReturnTo();

    navigate("/login", { replace: true });
  }

  return (
    <>
      {/* Identity is a statement, not a control — nothing happens if you
          press it, so it is not a button. */}
      <p className="flex items-center gap-2 px-2 py-1.5 text-sm text-ink-dim">
        <Avatar user={user} />
        <span className="min-w-0 truncate">{user.username}</span>
      </p>

      <button
        type="button"
        onClick={() => void onLogout()}
        className="rounded-chip px-2 py-1.5 text-left text-sm text-ink-dim hover:bg-recessed hover:text-ink"
      >
        Sign out
      </button>
    </>
  );
}
