/**
 * Pure pointer-gesture policy and state transitions.
 *
 * This module intentionally has no DOM, timers, repository mutations, or
 * browser globals. The DOM adapter owns those effects and feeds only semantic
 * events into this reducer.
 */

export const GESTURE_STATES = Object.freeze({
  idle: 'idle',
  possible: 'possible',
  swiping: 'swiping',
  renamingResolved: 'renamingResolved',
  dragging: 'dragging',
  cancelled: 'cancelled',
  ended: 'ended',
});

export const GESTURE_CONFIG = Object.freeze({
  edgeGuard: 28,
  axisLockDistance: 10,
  axisRatio: 1.3,
  actionDistance: 72,
  minSwipeVelocity: 0.25,
  deliberateSwipeDistance: 120,
  mouseDragDistance: 4,
  longPressDuration: 650,
  longPressMoveTolerance: 10,
  dragEdgeSize: 60,
  dragMaxSpeed: 18,
});

export const GESTURE_ZONES = Object.freeze({
  handle: 'handle',
  title: 'title',
  body: 'body',
  control: 'control',
});

/** @param {number} value @param {number} minimum @param {number} maximum */
function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

/** @param {number} dx @param {number} dy @param {Record<string, number>} [config] */
export function gestureAxis(dx, dy, config = GESTURE_CONFIG) {
  const horizontal = Math.abs(dx);
  const vertical = Math.abs(dy);
  if (Math.max(horizontal, vertical) < config.axisLockDistance) return 'undecided';
  if (horizontal >= vertical * config.axisRatio) return 'horizontal';
  if (vertical >= horizontal * config.axisRatio) return 'vertical';
  return 'undecided';
}

/** @param {number} dx @param {number} elapsedMs */
export function swipeVelocity(dx, elapsedMs) {
  const duration = Math.max(1, Number(elapsedMs) || 0);
  return Math.abs(dx) / duration;
}

/** @param {number} dx @param {number} dy @param {number} [elapsedMs] @param {Record<string, number>} [config] */
export function shouldCommitSwipe(dx, dy, elapsedMs = 0, config = GESTURE_CONFIG) {
  const horizontal = Math.abs(dx);
  const vertical = Math.abs(dy);
  if (horizontal < config.actionDistance || horizontal <= vertical * config.axisRatio) return false;
  if (gestureAxis(dx, dy, config) !== 'horizontal') return false;
  const velocity = swipeVelocity(dx, elapsedMs);
  return velocity >= config.minSwipeVelocity || horizontal >= config.deliberateSwipeDistance;
}

/** @param {number} dx */
export function swipeDirection(dx) { return dx < 0 ? 'left' : 'right'; }

/**
 * Keep the visual offset linear. A hard cap protects the action background,
 * but there is deliberately no acceleration, damping, or easing in the live
 * pointer position.
 *
 * @param {number} dx
 * @param {number} [maximum]
 */
export function liveSwipeOffset(dx, maximum = 128) {
  const value = Number(dx) || 0;
  return clamp(value, -Math.abs(maximum), Math.abs(maximum));
}

/** @param {{rowType?: string, surface?: string, isParent?: boolean, pathContext?: boolean}} [options] @returns {Record<string, any>} */
export function resolveInteractionPolicy({ rowType = 'item', surface = 'tree', isParent = false, pathContext = false } = {}) {
  if (rowType === 'category') {
    return Object.freeze({
      rowType,
      surface,
      titleTap: 'openCategory',
      bodyTap: 'openCategory',
      allowSwipe: false,
      allowRename: true,
      allowDrag: true,
    });
  }
  return Object.freeze({
    rowType: 'item',
    surface,
    // Item surfaces are inert on tap. Explicit controls (progress ring,
    // ellipsis, plus, status) own their actions; swipe and title long-press
    // remain separate gesture channels.
    titleTap: 'noop',
    bodyTap: 'noop',
    allowSwipe: true,
    allowRename: true,
    allowDrag: true,
  });
}

/**
 * @param {{pointerId?: number, pointerType?: string, zone?: string, startX?: number, startY?: number, time?: number, policy?: Record<string, any>, edgeGuarded?: boolean}} options
 * @returns {Record<string, any>}
 */
export function createGestureSession({
  pointerId = 0,
  pointerType = 'touch',
  zone = GESTURE_ZONES.body,
  startX = 0,
  startY = 0,
  time = 0,
  policy = resolveInteractionPolicy(),
  edgeGuarded = false,
} = {}) {
  // The handle is a dedicated direct-manipulation control. It starts a drag
  // on pointer down; only the title keeps a long-press rename affordance.
  // The system edge guard still owns horizontal movement for row content.
  const longPressEligible = pointerType !== 'mouse'
    && zone === GESTURE_ZONES.title
    && !edgeGuarded;
  return {
    state: GESTURE_STATES.possible,
    pointerId,
    pointerType,
    zone,
    startX,
    startY,
    lastX: startX,
    lastY: startY,
    startTime: time,
    lastTime: time,
    axis: 'undecided',
    winner: null,
    moved: false,
    edgeGuarded,
    longPressEligible,
    longPressPending: longPressEligible,
    policy,
    suppressClick: false,
  };
}

function moveEffect(session, event, dx, dy) {
  if (session.winner === 'swipe') return { type: 'swipeMove', dx, dy, x: event.x, y: event.y };
  if (session.winner === 'drag') return { type: 'dragMove', x: event.x, y: event.y };
  return null;
}

/**
 * @param {Record<string, any>} session
 * @param {{type: 'move'|'handleStart'|'longpress'|'up'|'cancel', x?: number, y?: number, time?: number}} event
 * @param {Record<string, number>} [config]
 * @returns {{session: Record<string, any>, effects: Array<Record<string, any>>}}
 */
export function stepGestureSession(session, event, config = GESTURE_CONFIG) {
  const next = { ...session };
  const effects = [];
  const x = Number.isFinite(event.x) ? event.x : next.lastX;
  const y = Number.isFinite(event.y) ? event.y : next.lastY;
  const time = Number.isFinite(event.time) ? event.time : next.lastTime;
  const dx = x - next.startX;
  const dy = y - next.startY;
  next.lastX = x;
  next.lastY = y;
  next.lastTime = time;

  if (event.type === 'handleStart') {
    if (next.state === GESTURE_STATES.possible && next.zone === GESTURE_ZONES.handle && next.policy.allowDrag) {
      next.state = GESTURE_STATES.dragging;
      next.winner = 'drag';
      next.suppressClick = true;
      effects.push({ type: 'dragStart' });
    }
    return { session: next, effects };
  }

  if (event.type === 'longpress') {
    if (next.state !== GESTURE_STATES.possible || !next.longPressPending || next.moved) return { session: next, effects };
    next.longPressPending = false;
    if (next.zone === GESTURE_ZONES.title && next.policy.allowRename) {
      next.state = GESTURE_STATES.renamingResolved;
      next.winner = 'rename';
      next.suppressClick = true;
      effects.push({ type: 'rename' });
    } else if (next.zone === GESTURE_ZONES.handle && next.policy.allowDrag) {
      next.state = GESTURE_STATES.dragging;
      next.winner = 'drag';
      next.suppressClick = true;
      effects.push({ type: 'dragStart' });
    }
    return { session: next, effects };
  }

  if (event.type === 'cancel') {
    if (next.state !== GESTURE_STATES.ended) {
      next.state = GESTURE_STATES.cancelled;
      next.suppressClick = next.suppressClick || next.moved || Boolean(next.winner);
      effects.push({ type: 'cancel' });
    }
    return { session: next, effects };
  }

  if (event.type === 'move') {
    if (next.state === GESTURE_STATES.swiping || next.state === GESTURE_STATES.dragging) {
      effects.push(moveEffect(next, event, dx, dy));
      return { session: next, effects: effects.filter(Boolean) };
    }
    if (next.state !== GESTURE_STATES.possible) return { session: next, effects };

    const distance = Math.max(Math.abs(dx), Math.abs(dy));
    if (distance === 0) return { session: next, effects };
    if (next.longPressPending && distance > config.longPressMoveTolerance) {
      next.longPressPending = false;
      effects.push({ type: 'cancelLongPress' });
    }
    if (next.zone === GESTURE_ZONES.handle) {
      if (next.pointerType === 'mouse' && distance >= config.mouseDragDistance && next.policy.allowDrag) {
        next.state = GESTURE_STATES.dragging;
        next.winner = 'drag';
        next.moved = true;
        next.suppressClick = true;
        effects.push({ type: 'dragStart' }, { type: 'dragMove', x, y });
      } else if (distance > config.longPressMoveTolerance) {
        next.moved = true;
        next.state = GESTURE_STATES.cancelled;
        next.suppressClick = true;
        effects.push({ type: 'cancel' });
      }
      return { session: next, effects };
    }
    if (!next.policy.allowSwipe || next.edgeGuarded || (next.zone !== GESTURE_ZONES.title && next.zone !== GESTURE_ZONES.body)) {
      if (distance > config.axisLockDistance) next.moved = true;
      return { session: next, effects };
    }
    const axis = gestureAxis(dx, dy, config);
    next.axis = axis;
    if (axis === 'vertical') {
      next.state = GESTURE_STATES.cancelled;
      next.moved = true;
      next.longPressPending = false;
      next.suppressClick = true;
      effects.push({ type: 'verticalScroll' });
    } else if (axis === 'horizontal') {
      next.state = GESTURE_STATES.swiping;
      next.winner = 'swipe';
      next.moved = true;
      next.longPressPending = false;
      next.suppressClick = true;
      effects.push({ type: 'swipeStart', direction: swipeDirection(dx) }, { type: 'swipeMove', dx, dy, x, y });
    } else if (distance > config.axisLockDistance) {
      next.moved = true;
      next.longPressPending = false;
    }
    return { session: next, effects };
  }

  if (event.type === 'up') {
    if (next.state === GESTURE_STATES.possible) {
      next.state = GESTURE_STATES.ended;
      next.longPressPending = false;
      if (!next.moved) {
        next.winner = 'tap';
        effects.push({ type: 'tap' });
      }
      return { session: next, effects };
    }
    if (next.state === GESTURE_STATES.swiping) {
      next.state = GESTURE_STATES.ended;
      next.longPressPending = false;
      next.suppressClick = true;
      const elapsedMs = Math.max(0, time - next.startTime);
      effects.push(shouldCommitSwipe(dx, dy, elapsedMs, config)
        ? { type: 'swipeCommit', direction: swipeDirection(dx), dx, dy, elapsedMs, velocity: swipeVelocity(dx, elapsedMs) }
        : { type: 'swipeCancel', dx, dy, elapsedMs });
      return { session: next, effects };
    }
    if (next.state === GESTURE_STATES.dragging) {
      next.state = GESTURE_STATES.ended;
      next.longPressPending = false;
      next.suppressClick = true;
      effects.push({ type: 'dragEnd', x, y });
      return { session: next, effects };
    }
    if (next.state === GESTURE_STATES.renamingResolved || next.state === GESTURE_STATES.cancelled) {
      next.state = GESTURE_STATES.ended;
      next.longPressPending = false;
      return { session: next, effects };
    }
  }
  return { session: next, effects };
}

/** @param {Record<string, any>} session */
export function shouldSuppressClick(session) {
  return Boolean(session?.suppressClick || session?.winner === 'swipe' || session?.winner === 'drag' || session?.winner === 'rename');
}

/** @param {number} pointerY @param {number} viewportTop @param {number} viewportBottom */
export function autoScrollSpeed(pointerY, viewportTop, viewportBottom, edgeSize = GESTURE_CONFIG.dragEdgeSize, maxSpeed = GESTURE_CONFIG.dragMaxSpeed) {
  if (pointerY < viewportTop || pointerY > viewportBottom) return 0;
  if (pointerY - viewportTop < edgeSize) return -maxSpeed * (1 - Math.max(0, pointerY - viewportTop) / edgeSize);
  if (viewportBottom - pointerY < edgeSize) return maxSpeed * (1 - Math.max(0, viewportBottom - pointerY) / edgeSize);
  return 0;
}

/** @param {{source?: any, target?: any, mode?: string}} [options] */
export function validateReorderTarget({ source, target, mode = 'tree' } = {}) {
  if (!source || !target || source.id === target.id) return { ok: false, reason: 'invalid_target' };
  if (source.conflicted || target.conflicted) return { ok: false, reason: 'conflict' };
  if (mode === 'smart') return { ok: true, reason: 'smart_order' };
  if (mode === 'category') return { ok: true, reason: 'category_order' };
  if (source.categoryId !== target.categoryId || source.parentId !== target.parentId || source.status !== target.status) {
    return { ok: false, reason: 'sibling_only' };
  }
  return { ok: true, reason: 'sibling_order' };
}
