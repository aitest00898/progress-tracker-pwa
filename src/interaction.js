/**
 * Shared interaction vocabulary. The DOM adapter lives in app.js and the
 * gesture reducer remains responsible for gesture ownership; these helpers
 * keep the visual state rules small, explicit, and testable.
 */
export const INTERACTION_CLASSES = Object.freeze({
  controlPressed: 'is-pressed',
  rowPressed: 'row-pressed',
  swipeReleasing: 'swipe-releasing',
});

export const INTERACTION_CONFIG = Object.freeze({
  controlPressScale: 0.98,
  rowPressScale: 0.995,
  pressOpacity: 0.78,
  releaseDurationMs: 180,
});

export function isDisabledControl(element) {
  return Boolean(element?.disabled || element?.getAttribute?.('aria-disabled') === 'true');
}

export function closestPressableControl(target, root) {
  if (!target || typeof target.closest !== 'function') return null;
  const control = target.closest('button, [role="button"]');
  if (!control || !root?.contains?.(control) || isDisabledControl(control)) return null;
  return control;
}

export function closestItemRow(target, root) {
  if (!target || typeof target.closest !== 'function') return null;
  const row = target.closest('.item-row, .category-nav-row');
  return row && root?.contains?.(row) ? row : null;
}

export function isRowPressCancellation(phase) {
  return phase === 'cancel' || phase === 'vertical' || phase === 'swipe' || phase === 'drag' || phase === 'rename';
}

export function focusableSelector() {
  return 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
}
