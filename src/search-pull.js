/**
 * Pure geometry/state helpers for the mobile pull-to-search affordance.
 * Row gestures remain owned by the existing gesture controller; this module
 * only claims a vertical pull that starts at the top search surface.
 */

export const SEARCH_DRAWER_STATES = Object.freeze({
  CLOSED: 'closed',
  PULLING: 'pulling',
  OPEN: 'open',
  CLOSING: 'closing'
});

export const SEARCH_PULL_CONFIG = Object.freeze({
  threshold: 76,
  maxPull: 120,
  axisLockDistance: 8,
  axisRatio: 1.25,
  closeThreshold: 56
});

/**
 * Search pull is intentionally started only by the compact top affordance.
 * Keeping this decision pure prevents a row's ordinary vertical scroll from
 * being claimed by the search controller.
 */
export function canStartSearchPull({ isAffordance = false, scrollTop = 0, isControl = false } = {}) {
  return Boolean(isAffordance && Number(scrollTop) <= 0 && !isControl);
}

export function createSearchPullSession({
  pointerId = 0,
  mode = 'open',
  startX = 0,
  startY = 0
} = {}) {
  return {
    pointerId,
    mode,
    startX,
    startY,
    lastX: startX,
    lastY: startY,
    distance: 0,
    axis: null,
    claimed: false,
    cancelled: false
  };
}

export function updateSearchPullSession(session, { x = session.lastX, y = session.lastY } = {}, config = SEARCH_PULL_CONFIG) {
  if (!session || session.cancelled) {
    return { session, distance: 0, axis: session?.axis ?? null, claimed: false, cancelled: true };
  }

  const dx = x - session.startX;
  const dy = y - session.startY;
  const absoluteX = Math.abs(dx);
  const absoluteY = Math.abs(dy);
  const nextSession = { ...session, lastX: x, lastY: y };

  if (!nextSession.axis && Math.max(absoluteX, absoluteY) >= config.axisLockDistance) {
    if (absoluteX > absoluteY * config.axisRatio) {
      nextSession.axis = 'horizontal';
      nextSession.cancelled = true;
      return { session: nextSession, distance: 0, axis: 'horizontal', claimed: false, cancelled: true };
    }
    if (absoluteY > absoluteX / config.axisRatio) nextSession.axis = 'vertical';
  }

  if (nextSession.axis === 'horizontal') {
    nextSession.cancelled = true;
    return { session: nextSession, distance: 0, axis: 'horizontal', claimed: false, cancelled: true };
  }

  const distance = nextSession.mode === 'close' ? Math.max(0, -dy) : Math.max(0, dy);
  nextSession.distance = Math.min(distance, config.maxPull);
  const claimed = nextSession.axis === 'vertical' && nextSession.distance > 0;
  nextSession.claimed = claimed;
  return {
    session: nextSession,
    distance: nextSession.distance,
    axis: nextSession.axis,
    claimed,
    cancelled: false
  };
}

export function resolveSearchPullRelease(session, config = SEARCH_PULL_CONFIG) {
  if (!session || session.cancelled) return session?.mode === 'close' ? 'open' : 'closed';
  const threshold = session.mode === 'close' ? config.closeThreshold : config.threshold;
  if (session.distance >= threshold) return session.mode === 'close' ? 'closed' : 'open';
  return session.mode === 'close' ? 'open' : 'closed';
}

/**
 * Pointer capture is deliberately delayed until the pull has claimed a
 * vertical gesture. Capturing at pointerdown prevents the browser's native
 * scroll pipeline from receiving ordinary list swipes.
 */
export function shouldCaptureSearchPull(previousSession, result) {
  return Boolean(previousSession && result && !previousSession.claimed && result.claimed && !result.cancelled);
}
