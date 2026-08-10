export const SWIPE_CONFIG = Object.freeze({
  edgeGuard: 28,
  axisLockDistance: 10,
  axisRatio: 1.3,
  actionDistance: 72,
});

export function classifySwipeAxis(dx, dy, {
  axisLockDistance = SWIPE_CONFIG.axisLockDistance,
  axisRatio = SWIPE_CONFIG.axisRatio,
} = {}) {
  const horizontal = Math.abs(dx);
  const vertical = Math.abs(dy);
  if (Math.max(horizontal, vertical) < axisLockDistance) return 'undecided';
  if (horizontal >= vertical * axisRatio) return 'horizontal';
  if (vertical >= horizontal * axisRatio) return 'vertical';
  return 'undecided';
}

export function swipeDirection(dx) {
  return dx < 0 ? 'left' : 'right';
}

export function swipeOffset(dx) {
  return Number.isFinite(dx) ? dx : 0;
}

export function shouldTriggerSwipe(dx, dy, {
  actionDistance = SWIPE_CONFIG.actionDistance,
  axisRatio = SWIPE_CONFIG.axisRatio,
} = {}) {
  const horizontal = Math.abs(dx);
  return horizontal >= actionDistance
    && horizontal > Math.abs(dy) * axisRatio;
}
