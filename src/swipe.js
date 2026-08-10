export const SWIPE_CONFIG = Object.freeze({
  edgeGuard: 28,
  axisLockDistance: 10,
  axisRatio: 1.3,
  actionDistance: 72,
  minVelocity: 0.18,
  maxOffset: 148,
  releaseDuration: 280,
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

export function swipeOffset(dx, width, { maxOffset = SWIPE_CONFIG.maxOffset } = {}) {
  const limit = Math.max(96, Math.min(maxOffset, Math.max(120, width * 0.55)));
  return Math.max(-limit, Math.min(limit, dx));
}

export function shouldTriggerSwipe(dx, dy, elapsed, {
  actionDistance = SWIPE_CONFIG.actionDistance,
  axisRatio = SWIPE_CONFIG.axisRatio,
  minVelocity = SWIPE_CONFIG.minVelocity,
} = {}) {
  const horizontal = Math.abs(dx);
  const duration = Math.max(1, elapsed);
  return horizontal >= actionDistance
    && horizontal > Math.abs(dy) * axisRatio
    && Math.abs(dx / duration) >= minVelocity;
}
