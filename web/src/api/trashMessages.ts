// web/src/api/trashMessages.ts — the ONE home for soft-delete lifecycle copy (#324:
// trash-toast-strings-duplicated). ListPage, ProjectionDetail, and TrashPage all read
// the toast strings from here so the wording is defined once and can never drift.

/** Toast after a successful move-to-Trash (ListPage + ProjectionDetail). */
export const TRASH_MOVED = "Moved to Trash";
/** Toast after a successful restore (TrashPage). */
export const TRASH_RESTORED = "Restored";
/** Toast after a successful permanent delete (TrashPage). */
export const TRASH_PURGED = "Permanently deleted";
/** Toast when a lifecycle action races another tab (version conflict). Shared by
 *  trash / restore / purge — they all report the same recoverable conflict. */
export const TRASH_CONFLICT =
  "This projection changed in another tab. Refresh and try again.";

/** A consistent "Could not <verb>. Try again." failure toast.
 *  e.g. trashCouldNot("move to Trash" | "restore" | "delete"). */
export function trashCouldNot(verb: string): string {
  return `Could not ${verb}. Try again.`;
}
