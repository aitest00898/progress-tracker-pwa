/**
 * Semantic feedback policy for visible mutations.
 *
 * A mutation that is already visible in the current surface should not also
 * produce a redundant success toast. Background work and operations whose
 * result may be off-screen still get a concise toast. Errors are handled by
 * the mutation boundary and always remain visible.
 */
export const FEEDBACK_MODES = Object.freeze({
  none: 'none',
  inline: 'inline',
  toast: 'toast',
  undoToast: 'undoToast',
  error: 'error',
});

const TOAST_LABELS = new Set([
  'backup_created',
  'conflict_archive_restored',
  'duplicate',
  'full_restore',
  'import_add_only',
  'move',
  'restore',
  'sync_push',
]);

const NO_SUCCESS_TOAST_KEYS = new Set(['savedOffline']);

/**
 * Resolve the success feedback channel for a repository mutation.
 * An explicit mode is reserved for exceptional surfaces such as the delete
 * undo action; ordinary mutations use this deterministic policy.
 *
 * @param {string} label
 * @param {string|null} successKey
 * @param {string|null} requested
 * @returns {string}
 */
export function mutationFeedback(label, successKey = null, requested = null) {
  const validRequested = requested ? Object.values(FEEDBACK_MODES).find((mode) => mode === requested) : null;
  if (validRequested) return validRequested;
  if (!successKey || NO_SUCCESS_TOAST_KEYS.has(successKey)) return FEEDBACK_MODES.none;
  if (TOAST_LABELS.has(label)) return FEEDBACK_MODES.toast;
  return FEEDBACK_MODES.none;
}
