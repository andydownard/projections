// web/src/components/UserMenu.tsx — the owner account avatar + dropdown (Epic #319).
//
// Replaces Clerk's prebuilt <UserButton/> with a project-tokened control (built
// from timpager's avatar-menu pattern): a round avatar trigger that shows the
// user's photo when they have one, else their initials on a brand-tinted circle;
// an absolute role=menu dropdown with "Settings" (opens the Clerk user profile) and
// a destructive "Logout" (signs out, then returns to the home route).
//
// Identity comes from useUser(); the actions come from useClerk(). This module is
// only ever reached through the lazy OwnerAuthControls (rendered when the Clerk
// satellite is active), so the @clerk/clerk-react import stays code-split out of
// the ship-dark bundle — the SHIP-DARK invariant is preserved.
//
// a11y: aria-expanded on the trigger, the menu's first item is focused on open,
// and both Escape and an outside click close the menu and restore focus to the
// trigger.
import { useClerk, useUser } from "@clerk/clerk-react";
import { useCallback, useEffect, useRef, useState } from "react";

/** Initials from first/last, falling back to the full name, then "?". */
function userInitials(user: {
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
}): string {
  const first = (user.firstName ?? "").trim();
  const last = (user.lastName ?? "").trim();
  const fromNames = (first.charAt(0) + last.charAt(0)).trim();
  if (fromNames) return fromNames.toUpperCase();
  const full = (user.fullName ?? "").trim();
  if (full) return full.charAt(0).toUpperCase();
  return "?";
}

export function UserMenu() {
  const { user } = useUser();
  const clerk = useClerk();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  // Move focus into the menu when it opens so keyboard users land on the first
  // action rather than being stranded on the (now-expanded) trigger.
  useEffect(() => {
    if (open) firstItemRef.current?.focus();
  }, [open]);

  // Close on Escape (restore focus to the trigger) or on a click outside the
  // wrapper. Mirrors the timpager avatar-menu behaviour, scoped to this instance.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    }
    function onPointerDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open, close]);

  // useUser() can briefly return a null user before Clerk hydrates; render nothing
  // rather than an empty avatar.
  if (!user) return null;

  const handleSettings = () => {
    setOpen(false);
    clerk.openUserProfile();
  };

  const handleLogout = async () => {
    setOpen(false);
    await clerk.signOut();
    window.location.assign("/");
  };

  return (
    <div className="user-menu" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="user-menu__trigger"
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {user.hasImage ? (
          <img className="user-menu__avatar" src={user.imageUrl} alt="" />
        ) : (
          <span
            className="user-menu__avatar user-menu__avatar--initials"
            aria-hidden="true"
          >
            {userInitials(user)}
          </span>
        )}
      </button>
      {open && (
        <div className="user-menu__dropdown" role="menu" aria-label="Account actions">
          <button
            ref={firstItemRef}
            type="button"
            role="menuitem"
            className="user-menu__item"
            onClick={handleSettings}
          >
            Settings
          </button>
          <div className="user-menu__divider" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="user-menu__item user-menu__item--danger"
            onClick={handleLogout}
          >
            Logout
          </button>
        </div>
      )}
    </div>
  );
}
