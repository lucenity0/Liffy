import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { useAuth } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";
import type { UserOut } from "@/types/api";

/**
 * Who you are signed in as, and the way out.
 *
 * Hand-rolled rather than built on a primitive because `components/ui/` has
 * no dropdown — `Modal` is a native `<dialog>`, which is far too heavy for a
 * two-item menu and would trap focus for a control the user is only glancing
 * at. The keyboard contract below is the part that a hand-rolled menu
 * usually gets wrong, so it is explicit.
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
  const menuId = useId();
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
    navigate("/login", { replace: true });
  }

  return (
    <div ref={containerRef} className="relative">
      <Button
        ref={triggerRef}
        variant="ghost"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
      >
        <Avatar user={user} />
        <span className="max-w-32 truncate">{user.username}</span>
      </Button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Account"
          className={cn(
            "rounded-sheet absolute right-0 z-30 mt-1 min-w-44 overflow-hidden",
            "border border-rule-strong bg-card py-1 shadow-hard-lg",
          )}
        >
          <p className="label px-3 py-1.5 text-ink-sub">
            Signed in as <span className="text-ink">{user.username}</span>
          </p>
          <button
            type="button"
            role="menuitem"
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
