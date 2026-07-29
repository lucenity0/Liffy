import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { useAuth } from "@/hooks/useAuth";
import { clearReturnTo } from "@/lib/returnTo";
import { cn } from "@/lib/utils";
import type { UserOut } from "@/types/api";

/**
 * Who you are signed in as, and the way out.
 *
 * Hand-rolled rather than built on a primitive because `components/ui/` has
 * no dropdown — `Modal` is a native `<dialog>`, which is far too heavy for
 * two lines of content and would trap focus for a control the user is only
 * glancing at.
 *
 * **A disclosure, not a `role="menu"`.** ARIA reserves `menu` for
 * application menus, and its keyboard model is arrow-key navigation between
 * `menuitem`s with a roving tabindex. What this actually implements is Tab
 * through ordinary controls in DOM order — the right model for an account
 * dropdown, and the honest markup for it is a button with `aria-expanded`
 * over a plain container. Claiming `menu` while behaving like a disclosure
 * is worse than either: assistive technology walking it in application mode
 * moves between menuitems, so the "Signed in as …" line risks never being
 * announced at all.
 *
 * The keyboard contract below is the part hand-rolled dropdowns usually get
 * wrong, so it is explicit.
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
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      // Focus goes back to the trigger, not to the top of the document —
      // otherwise Escape silently loses the user's place in the tab order.
      triggerRef.current?.focus();
    };

    // Pointer, not click: a mousedown outside should dismiss immediately
    // rather than waiting for the button-up that may land elsewhere.
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  if (!user) return null;

  async function onLogout() {
    setOpen(false);
    // `logout` never rejects: it clears local state even when the revoke call
    // fails, so a user who clicks Log out always ends up logged out.
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
    <div ref={containerRef} className="relative">
      <Button
        ref={triggerRef}
        variant="ghost"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
      >
        <Avatar user={user} />
        <span className="max-w-32 truncate">{user.username}</span>
      </Button>

      {open && (
        <div
          id={panelId}
          data-testid="user-menu"
          className={cn(
            "rounded-sheet absolute right-0 z-30 mt-1 min-w-44 overflow-hidden",
            "border border-rule-strong bg-card py-1 shadow-hard-lg",
          )}
        >
          {/* An ordinary paragraph in an ordinary container, so it is read
              like any other content. Under `role="menu"` this was a
              non-conforming child and liable to be skipped entirely. */}
          <p className="label px-3 py-1.5 text-ink-sub">
            Signed in as <span className="text-ink">{user.username}</span>
          </p>
          <button
            type="button"
            onClick={() => void onLogout()}
            className="w-full px-3 py-1.5 text-left text-base text-ink hover:bg-recessed focus-visible:bg-recessed"
          >
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
