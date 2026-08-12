import {
  GESTURE_CONFIG,
  GESTURE_ZONES,
  autoScrollSpeed,
  createGestureSession,
  resolveInteractionPolicy,
  stepGestureSession,
} from './gesture.js';

const DEFAULT_ROW_SELECTOR = '.item-row, .category-nav-row';

/**
 * Small DOM adapter around the pure gesture reducer. One controller is bound
 * to the stable app root, so virtualized rows may be replaced without
 * replacing gesture listeners or the active drag session.
 *
 * @param {HTMLElement} root
 * @param {{rowSelector?: string, getPolicy?: (context: {row: HTMLElement, zone: string, event: PointerEvent}) => Record<string, any>, getRowKey?: (row: HTMLElement) => string|null, onOutsidePointerDown?: (context: {event: PointerEvent, row: HTMLElement|null}) => void, onPressVisual?: (context: {row: HTMLElement, phase: string, zone?: string, session: Record<string, any>}) => void, onTap?: (context: {row: HTMLElement, zone: string, session: Record<string, any>, event: PointerEvent}) => void, onRename?: (context: {row: HTMLElement, zone: string, session: Record<string, any>, event: PointerEvent}) => void, onSwipeVisual?: (context: {row: HTMLElement, phase: string, dx?: number, direction?: string, session: Record<string, any>}) => void, onSwipe?: (context: {row: HTMLElement, direction: string, session: Record<string, any>, event: PointerEvent}) => void, onDragStart?: (context: {row: HTMLElement, session: Record<string, any>, event: PointerEvent|null}) => boolean|void, resolveDragTarget?: (context: {row: HTMLElement, session: Record<string, any>, x: number, y: number}) => {id?: string|null, beforeId?: string|null, noOp?: boolean, position?: string, allowed?: boolean, row?: HTMLElement|null}|null, onDragTarget?: (context: {row: HTMLElement, session: Record<string, any>, target: {id?: string|null, beforeId?: string|null, noOp?: boolean, position?: string, allowed?: boolean, row?: HTMLElement|null}|null}) => void, onDragMove?: (context: {row: HTMLElement, session: Record<string, any>, x: number, y: number, scrollTop?: number, scrollLeft?: number, dragStartScrollTop?: number, dragStartScrollLeft?: number}) => void, onDragEnd?: (context: {row: HTMLElement, session: Record<string, any>, target: {id?: string|null, beforeId?: string|null, noOp?: boolean, position?: string, allowed?: boolean, row?: HTMLElement|null}|null, event: PointerEvent}) => void, onCancel?: (context: {row: HTMLElement, session: Record<string, any>}) => void, getScrollContainer?: (context: {row: HTMLElement, session: Record<string, any>}) => HTMLElement|null, now?: () => number, longPressDuration?: number}} [options]
 */
export function createGestureController(root, options = {}) {
  const config = { ...GESTURE_CONFIG, longPressDuration: options.longPressDuration ?? GESTURE_CONFIG.longPressDuration };
  const rowSelector = options.rowSelector ?? DEFAULT_ROW_SELECTOR;
  const sessions = new Map();
  const suppressedClicks = new Map();
  const documentTarget = root.ownerDocument ?? null;
  let activePointerId = null;

  function now() { return options.now?.() ?? (globalThis.performance?.now?.() ?? Date.now()); }
  function rowForTarget(target) {
    if (!target || typeof target.closest !== 'function') return null;
    const row = target.closest(rowSelector);
    return (typeof HTMLElement === 'undefined' || row instanceof HTMLElement) && root.contains(row) ? row : null;
  }
  function zoneForTarget(target, row) {
    if (!target || !row || typeof target.closest !== 'function') return GESTURE_ZONES.body;
    const explicit = target.closest('[data-gesture-zone]');
    if (explicit && row.contains(explicit)) return explicit.dataset.gestureZone ?? GESTURE_ZONES.body;
    if (target.closest('button, input, select, textarea, a')) return GESTURE_ZONES.control;
    return GESTURE_ZONES.body;
  }
  function keyForRow(row) {
    const custom = options.getRowKey?.(row);
    if (custom) return custom;
    return row.dataset.itemId ? `item:${row.dataset.itemId}` : row.dataset.categoryId ? `category:${row.dataset.categoryId}` : null;
  }
  /** @returns {Record<string, any>} */
  function policyFor(row, zone, event) {
    return options.getPolicy?.({ row, zone, event }) ?? resolveInteractionPolicy({
      rowType: row.classList.contains('category-nav-row') ? 'category' : 'item',
      surface: row.dataset.gestureContext ?? 'tree',
      isParent: row.dataset.hasChildren === 'true',
      pathContext: row.dataset.gestureContext !== 'tree',
    });
  }
  function isEdgeGuarded(event, policy) {
    if (!policy.allowSwipe || typeof window === 'undefined') return false;
    return event.clientX <= config.edgeGuard || event.clientX >= window.innerWidth - config.edgeGuard;
  }
  function pointerCapture(session, preferredTarget = null) {
    const pointerId = session.pointerId;
    if (pointerId === undefined || pointerId === null) return;
    for (const target of [preferredTarget, root]) {
      if (!target?.setPointerCapture) continue;
      try { target.setPointerCapture(pointerId); } catch { /* pointer may have ended before capture */ }
    }
  }
  function releasePointer(session, preferredTarget = null) {
    const pointerId = session.pointerId;
    if (pointerId === undefined || pointerId === null) return;
    for (const target of [preferredTarget, root]) {
      if (!target?.releasePointerCapture) continue;
      try { target.releasePointerCapture(pointerId); } catch { /* capture is best effort */ }
    }
  }
  function markSuppressed(row) {
    const key = keyForRow(row);
    if (key) suppressedClicks.set(key, now() + 500);
  }
  function clearDragClasses() {
    root.querySelectorAll?.('.drag-target, .drag-target-before, .drag-target-after, .category-drag-target, .dragging, .category-dragging, .long-pressed').forEach((element) => {
      element.classList.remove('drag-target', 'drag-target-before', 'drag-target-after', 'category-drag-target', 'dragging', 'category-dragging', 'long-pressed');
      const htmlElement = /** @type {HTMLElement} */ (element);
      htmlElement.style?.removeProperty?.('--drag-x');
      htmlElement.style?.removeProperty?.('--drag-y');
    });
  }
  function clearSwipeVisual(record) {
    if (record.swipeVisualCleared) return;
    record.swipeVisualCleared = true;
    options.onSwipeVisual?.({ row: record.row, phase: 'end', dx: 0, session: record.session });
  }
  function clearPressVisual(record, phase = 'end') {
    if (!record.pressActive) return;
    record.pressActive = false;
    options.onPressVisual?.({ row: record.row, phase, zone: record.session.zone, session: record.session });
  }
  function scrollContainerIsLive(record) {
    const scrollContainer = record.scrollContainer;
    if (!scrollContainer || scrollContainer.isConnected === false) return false;
    const documentScroller = record.row?.ownerDocument?.scrollingElement ?? documentTarget?.scrollingElement;
    if (scrollContainer.nodeType === 1 && scrollContainer !== documentScroller && root.contains && !root.contains(scrollContainer)) return false;
    return typeof scrollContainer.getBoundingClientRect === 'function';
  }
  function scheduleAutoScroll(record) {
    if (record.autoScrollFrame !== 0 || !record.scrollContainer) return;
    const tick = () => {
      record.autoScrollFrame = 0;
      if (!sessions.has(record.session.pointerId) || record.session.state !== 'dragging') return;
      if (!scrollContainerIsLive(record)) {
        finish(record, { clientX: record.session.lastX, clientY: record.session.lastY }, true);
        return;
      }
      const scrollContainer = record.scrollContainer;
      let keepRunning = false;
      const rect = scrollContainer.getBoundingClientRect();
      const speed = autoScrollSpeed(record.session.lastY, rect.top, rect.bottom, config.dragEdgeSize, config.dragMaxSpeed);
      if (speed !== 0) {
        const before = scrollContainer.scrollTop;
        const maximum = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
        scrollContainer.scrollTop = Math.max(0, Math.min(maximum, scrollContainer.scrollTop + speed));
        keepRunning = scrollContainer.scrollTop !== before;
      }
      refreshDragTarget(record);
      options.onDragMove?.({
        row: record.row,
        session: record.session,
        x: record.session.lastX,
        y: record.session.lastY,
        scrollTop: scrollContainer.scrollTop ?? 0,
        scrollLeft: scrollContainer.scrollLeft ?? 0,
        dragStartScrollTop: record.dragStartScrollTop ?? 0,
        dragStartScrollLeft: record.dragStartScrollLeft ?? 0,
      });
      if (keepRunning) record.autoScrollFrame = requestAnimationFrame(tick);
    };
    record.autoScrollFrame = requestAnimationFrame(tick);
  }
  function stopAutoScroll(record) {
    if (record.autoScrollFrame === 0) return;
    cancelAnimationFrame(record.autoScrollFrame);
    record.autoScrollFrame = 0;
  }
  function refreshDragTarget(record) {
    const target = options.resolveDragTarget?.({ row: record.row, session: record.session, x: record.session.lastX, y: record.session.lastY }) ?? null;
    if (target?.row && !target.allowed) target.row.classList.remove('drag-target', 'drag-target-before', 'drag-target-after', 'category-drag-target');
    root.querySelectorAll?.('.drag-target, .drag-target-before, .drag-target-after, .category-drag-target').forEach((element) => element.classList.remove('drag-target', 'drag-target-before', 'drag-target-after', 'category-drag-target'));
    if (target?.row && target.allowed) {
      if (target.row.classList.contains('category-nav-row')) target.row.classList.add('category-drag-target');
      else {
        target.row.classList.add('drag-target');
        target.row.classList.add(target.position === 'after' ? 'drag-target-after' : 'drag-target-before');
      }
    }
    record.target = target;
    options.onDragTarget?.({ row: record.row, session: record.session, target });
  }
  function clearTimer(record) {
    if (record.timer) clearTimeout(record.timer);
    record.timer = null;
  }
  function callEffect(record, effect, event) {
    if (!effect) return true;
    if (effect.type === 'cancelLongPress') { clearTimer(record); return true; }
    if (effect.type === 'swipeStart') {
      clearTimer(record);
      clearPressVisual(record, 'swipe');
      pointerCapture(record.session, record.pointerTarget);
      event?.preventDefault?.();
      options.onSwipeVisual?.({ row: record.row, phase: 'start', direction: effect.direction, dx: 0, session: record.session });
      return true;
    }
    if (effect.type === 'swipeMove') {
      event?.preventDefault?.();
      options.onSwipeVisual?.({ row: record.row, phase: 'move', dx: effect.dx, direction: effect.dx < 0 ? 'left' : 'right', session: record.session });
      return true;
    }
    if (effect.type === 'swipeCancel') {
      markSuppressed(record.row);
      clearSwipeVisual(record);
      return true;
    }
    if (effect.type === 'swipeCommit') {
      markSuppressed(record.row);
      clearSwipeVisual(record);
      options.onSwipe?.({ row: record.row, direction: effect.direction, session: record.session, event });
      return true;
    }
    if (effect.type === 'rename') {
      clearTimer(record);
      clearPressVisual(record, 'rename');
      markSuppressed(record.row);
      record.row.classList.add('long-pressed');
      if (canUseHaptic()) globalThis.navigator.vibrate(8);
      options.onRename?.({ row: record.row, zone: record.session.zone, session: record.session, event });
      return true;
    }
    if (effect.type === 'dragStart') {
      clearTimer(record);
      clearPressVisual(record, 'drag');
      pointerCapture(record.session, record.pointerTarget);
      event?.preventDefault?.();
      if (canUseHaptic()) globalThis.navigator.vibrate(8);
      const accepted = options.onDragStart?.({ row: record.row, session: record.session, event }) !== false;
      if (!accepted) {
        record.session = { ...record.session, state: 'cancelled', winner: null };
        options.onCancel?.({ row: record.row, session: record.session });
        return false;
      }
      if (options.getScrollContainer) {
        record.scrollContainer = options.getScrollContainer({ row: record.row, session: record.session });
        if (!record.scrollContainer) {
          record.session = { ...record.session, state: 'cancelled', winner: null };
          options.onCancel?.({ row: record.row, session: record.session });
          return false;
        }
      }
      record.dragStartScrollTop = record.scrollContainer?.scrollTop ?? 0;
      record.dragStartScrollLeft = record.scrollContainer?.scrollLeft ?? 0;
      scheduleAutoScroll(record);
      return true;
    }
    if (effect.type === 'dragMove') {
      event?.preventDefault?.();
      refreshDragTarget(record);
      options.onDragMove?.({
        row: record.row,
        session: record.session,
        x: effect.x,
        y: effect.y,
        scrollTop: record.scrollContainer?.scrollTop ?? 0,
        scrollLeft: record.scrollContainer?.scrollLeft ?? 0,
        dragStartScrollTop: record.dragStartScrollTop ?? 0,
        dragStartScrollLeft: record.dragStartScrollLeft ?? 0,
      });
      scheduleAutoScroll(record);
      return true;
    }
    if (effect.type === 'dragEnd') {
      markSuppressed(record.row);
      options.onDragEnd?.({ row: record.row, session: record.session, target: record.target ?? null, event });
      return true;
    }
    if (effect.type === 'tap') {
      markSuppressed(record.row);
      options.onTap?.({ row: record.row, zone: record.session.zone, session: record.session, event });
      return true;
    }
    if (effect.type === 'verticalScroll') { clearPressVisual(record, 'vertical'); return true; }
    if (effect.type === 'cancel') {
      clearTimer(record);
      clearPressVisual(record, 'cancel');
      options.onCancel?.({ row: record.row, session: record.session });
      return true;
    }
    return true;
  }
  function process(record, transition, event) {
    const result = stepGestureSession(record.session, transition, config);
    record.session = result.session;
    for (const effect of result.effects) {
      if (!callEffect(record, effect, event)) break;
    }
    return result;
  }
  function finish(record, event, cancelled = false) {
    clearTimer(record);
    stopAutoScroll(record);
    releasePointer(record.session, record.pointerTarget);
    if (cancelled) {
      const result = process(record, { type: 'cancel', x: event?.clientX, y: event?.clientY, time: now() }, event);
      record.session = result.session;
    }
    if (record.session.winner === 'swipe' || record.session.winner === 'rename') clearSwipeVisual(record);
    clearPressVisual(record, cancelled ? 'cancel' : 'end');
    const swipeReleaseOwnsOffset = record.row.classList.contains('swipe-releasing');
    record.row.classList.remove('drag-target', 'drag-target-before', 'drag-target-after', 'category-drag-target', 'dragging', 'category-dragging', 'long-pressed', 'is-swiping', 'swipe-left', 'swipe-right');
    if (!swipeReleaseOwnsOffset) record.row.style?.removeProperty?.('--swipe-x');
    record.row.style?.removeProperty?.('--drag-x');
    record.row.style?.removeProperty?.('--drag-y');
    clearDragClasses();
    record.scrollContainer = null;
    sessions.delete(record.session.pointerId);
    if (activePointerId === record.session.pointerId) activePointerId = null;
  }
  function onPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    const row = rowForTarget(event.target);
    if (!documentTarget) options.onOutsidePointerDown?.({ event, row });
    if (!row || activePointerId !== null) return;
    const zone = zoneForTarget(event.target, row);
    if (zone === GESTURE_ZONES.control) return;
    const policy = policyFor(row, zone, event);
    const session = createGestureSession({
      pointerId: event.pointerId,
      pointerType: event.pointerType || 'touch',
      zone,
      startX: event.clientX,
      startY: event.clientY,
      time: now(),
      policy,
      edgeGuarded: isEdgeGuarded(event, policy),
    });
    const record = { row, pointerTarget: event.target, session, timer: null, target: null, autoScrollFrame: 0, scrollContainer: null, pressActive: true, swipeVisualCleared: false };
    sessions.set(session.pointerId, record);
    activePointerId = session.pointerId;
    options.onPressVisual?.({ row, phase: 'start', zone, session });
    if (zone === GESTURE_ZONES.handle && session.policy.allowDrag) {
      process(record, { type: 'handleStart', time: now() }, event);
    } else if (session.longPressPending) {
      record.timer = setTimeout(() => {
        if (!sessions.has(session.pointerId)) return;
        process(record, { type: 'longpress', time: now() }, null);
      }, config.longPressDuration);
    }
  }
  function onPointerMove(event) {
    const record = sessions.get(event.pointerId);
    if (!record) return;
    const result = process(record, { type: 'move', x: event.clientX, y: event.clientY, time: now() }, event);
    if (result.session.state === 'swiping' || result.session.state === 'dragging') event.preventDefault();
  }
  function onPointerUp(event) {
    const record = sessions.get(event.pointerId);
    if (!record) return;
    process(record, { type: 'up', x: event.clientX, y: event.clientY, time: now() }, event);
    finish(record, event);
  }
  function onPointerCancel(event) {
    const record = sessions.get(event.pointerId);
    if (!record) return;
    finish(record, event, true);
  }
  function onDocumentPointerMove(event) {
    if (root.contains?.(event.target)) return;
    onPointerMove(event);
  }
  function onDocumentPointerUp(event) {
    onPointerUp(event);
  }
  function onDocumentPointerCancel(event) {
    onPointerCancel(event);
  }
  function onClick(event) {
    const row = rowForTarget(event.target);
    if (!row) return;
    const key = keyForRow(row);
    const until = key ? suppressedClicks.get(key) : 0;
    if (!until) return;
    if (until < now()) { suppressedClicks.delete(key); return; }
    suppressedClicks.delete(key);
    event.preventDefault();
    event.stopPropagation();
  }
  function onKeydown(event) {
    if (event.key === 'Escape') cancelAll();
  }
  function onDocumentPointerDown(event) {
    options.onOutsidePointerDown?.({ event, row: rowForTarget(event.target) });
  }
  function cancelAll() {
    for (const record of [...sessions.values()]) finish(record, { clientX: record.session.lastX, clientY: record.session.lastY }, true);
    clearDragClasses();
    suppressedClicks.clear();
  }

  root.addEventListener('pointerdown', onPointerDown, true);
  root.addEventListener('pointermove', onPointerMove, true);
  root.addEventListener('pointerup', onPointerUp, true);
  root.addEventListener('pointercancel', onPointerCancel, true);
  root.addEventListener('click', onClick, true);
  root.addEventListener('keydown', onKeydown, true);
  documentTarget?.addEventListener('pointerdown', onDocumentPointerDown, true);
  documentTarget?.addEventListener('pointermove', onDocumentPointerMove, true);
  documentTarget?.addEventListener('pointerup', onDocumentPointerUp, true);
  documentTarget?.addEventListener('pointercancel', onDocumentPointerCancel, true);

  return {
    cancelAll,
    dispose() {
      cancelAll();
      root.removeEventListener('pointerdown', onPointerDown, true);
      root.removeEventListener('pointermove', onPointerMove, true);
      root.removeEventListener('pointerup', onPointerUp, true);
      root.removeEventListener('pointercancel', onPointerCancel, true);
      root.removeEventListener('click', onClick, true);
      root.removeEventListener('keydown', onKeydown, true);
      documentTarget?.removeEventListener('pointerdown', onDocumentPointerDown, true);
      documentTarget?.removeEventListener('pointermove', onDocumentPointerMove, true);
      documentTarget?.removeEventListener('pointerup', onDocumentPointerUp, true);
      documentTarget?.removeEventListener('pointercancel', onDocumentPointerCancel, true);
    },
    getActiveSession() { return activePointerId === null ? null : sessions.get(activePointerId)?.session ?? null; },
    getSessionCount() { return sessions.size; },
  };
}

function canUseHaptic() {
  return Boolean(globalThis.navigator?.vibrate) && /Android/i.test(globalThis.navigator?.userAgent ?? '');
}

export { autoScrollSpeed };
