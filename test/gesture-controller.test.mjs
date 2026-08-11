import test from 'node:test';
import assert from 'node:assert/strict';
import { createGestureController } from '../src/gesture-controller.js';
import { GESTURE_ZONES } from '../src/gesture.js';

class FakeClassList {
  constructor(value = '') { this.values = new Set(value.split(/\s+/).filter(Boolean)); }
  add(...values) { values.forEach((value) => this.values.add(value)); }
  remove(...values) { values.forEach((value) => this.values.delete(value)); }
  contains(value) { return this.values.has(value); }
  toggle(value, force) { const next = force === undefined ? !this.values.has(value) : force; if (next) this.values.add(value); else this.values.delete(value); return next; }
}

class FakeElement {
  constructor({ className = '', tagName = 'DIV', dataset = {} } = {}) {
    this.classList = new FakeClassList(className);
    this.tagName = tagName;
    this.nodeType = 1;
    this.dataset = { ...dataset };
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.style = { setProperty: (key, value) => { this.style[key] = value; }, removeProperty: (key) => { delete this.style[key]; } };
    this.capture = new Set();
  }
  append(...children) { children.forEach((child) => { child.parentNode = this; this.children.push(child); }); }
  removeChild(child) { this.children = this.children.filter((candidate) => candidate !== child); child.parentNode = null; }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  addEventListener(type, handler, options = false) { const list = this.listeners.get(type) ?? []; list.push({ handler, capture: options === true || options.capture === true }); this.listeners.set(type, list); }
  removeEventListener(type, handler) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry.handler !== handler)); }
  setPointerCapture(pointerId) { this.capture.add(pointerId); }
  releasePointerCapture(pointerId) { this.capture.delete(pointerId); }
  matches(selector) {
    if (selector === '.item-row') return this.classList.contains('item-row');
    if (selector === '.category-nav-row') return this.classList.contains('category-nav-row');
    if (selector === '.quick-action-row') return this.classList.contains('quick-action-row');
    if (selector === '.quick-actions-trigger') return this.classList.contains('quick-actions-trigger');
    if (selector === 'button') return this.tagName === 'BUTTON';
    if (selector === 'input') return this.tagName === 'INPUT';
    if (selector === 'select') return this.tagName === 'SELECT';
    if (selector === 'textarea') return this.tagName === 'TEXTAREA';
    if (selector === 'a') return this.tagName === 'A';
    if (selector === '[data-gesture-zone]') return Boolean(this.dataset.gestureZone);
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    return false;
  }
  closest(selector) {
    const selectors = selector.split(',').map((value) => value.trim());
    let cursor = this;
    while (cursor) {
      if (selectors.some((candidate) => cursor.matches(candidate))) return cursor;
      cursor = cursor.parentNode;
    }
    return null;
  }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map((value) => value.trim());
    const matches = [];
    const visit = (node) => {
      if (selectors.some((candidate) => node.matches(candidate))) matches.push(node);
      node.children.forEach(visit);
    };
    this.children.forEach(visit);
    return matches;
  }
  dispatch(type, target, extra = {}) {
    const event = {
      type,
      target,
      pointerId: extra.pointerId ?? 1,
      pointerType: extra.pointerType ?? 'touch',
      button: extra.button ?? 0,
      clientX: extra.clientX ?? 100,
      clientY: extra.clientY ?? 100,
      key: extra.key,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
    };
    for (const entry of this.listeners.get(type) ?? []) entry.handler(event);
    return event;
  }
}

function makeRows() {
  const root = new FakeElement({ className: 'app-root' });
  const parent = new FakeElement({ className: 'item-row tree-row', dataset: { itemId: 'parent', gestureRow: 'item', gestureContext: 'tree', hasChildren: 'true' } });
  const child = new FakeElement({ className: 'item-row tree-row tree-child', dataset: { itemId: 'child', gestureRow: 'item', gestureContext: 'tree', hasChildren: 'false' } });
  const parentTitle = new FakeElement({ tagName: 'BUTTON', dataset: { gestureZone: GESTURE_ZONES.title } });
  const parentDue = new FakeElement({ dataset: { gestureZone: GESTURE_ZONES.body } });
  const childBody = new FakeElement({ dataset: { gestureZone: GESTURE_ZONES.body } });
  const handle = new FakeElement({ tagName: 'BUTTON', dataset: { gestureZone: GESTURE_ZONES.handle } });
  const control = new FakeElement({ tagName: 'BUTTON', dataset: { gestureZone: GESTURE_ZONES.control } });
  parent.append(parentTitle, parentDue, handle, control);
  child.append(childBody);
  root.append(parent, child);
  return { root, parent, child, parentTitle, parentDue, childBody, handle, control };
}

function pointer(root, type, target, x, y, options = {}) { return root.dispatch(type, target, { ...options, clientX: x, clientY: y }); }
function wait(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

test('delegated tap semantics cover parent title/due/blank, leaf body, and controls', () => {
  const { root, parent, parentTitle, parentDue, childBody, control } = makeRows();
  const taps = [];
  const controller = createGestureController(root, { onTap: ({ row, zone }) => taps.push(`${row.dataset.itemId}:${zone}`) });
  pointer(root, 'pointerdown', parentTitle, 100, 100);
  pointer(root, 'pointerup', parentTitle, 100, 100);
  pointer(root, 'click', parentTitle, 100, 100);
  pointer(root, 'pointerdown', parentDue, 100, 120);
  pointer(root, 'pointerup', parentDue, 100, 120);
  pointer(root, 'pointerdown', parent, 100, 125);
  pointer(root, 'pointerup', parent, 100, 125);
  pointer(root, 'pointerdown', childBody, 100, 140);
  pointer(root, 'pointerup', childBody, 100, 140);
  pointer(root, 'pointerdown', control, 100, 160);
  pointer(root, 'pointerup', control, 100, 160);
  assert.deepEqual(taps, ['parent:title', 'parent:body', 'parent:body', 'child:body']);
  assert.equal(controller.getSessionCount(), 0);
  controller.dispose();
});

test('row press feedback starts on pointerdown and clears on tap, scroll, swipe, drag, and cancel', async () => {
  const { root, child, childBody, handle } = makeRows();
  const phases = [];
  const controller = createGestureController(root, {
    longPressDuration: 8,
    onPressVisual: ({ phase }) => phases.push(phase),
    onDragStart: () => true,
    resolveDragTarget: () => ({ id: 'child', allowed: true, row: child }),
  });

  pointer(root, 'pointerdown', childBody, 100, 100, { pointerId: 101 });
  assert.equal(phases.at(-1), 'start');
  pointer(root, 'pointerup', childBody, 100, 100, { pointerId: 101 });
  assert.equal(phases.slice(-2).join(','), 'start,end');

  pointer(root, 'pointerdown', childBody, 100, 120, { pointerId: 102 });
  pointer(root, 'pointermove', childBody, 103, 150, { pointerId: 102 });
  assert.equal(phases.at(-1), 'vertical');
  pointer(root, 'pointerup', childBody, 103, 150, { pointerId: 102 });

  pointer(root, 'pointerdown', childBody, 200, 180, { pointerId: 103 });
  pointer(root, 'pointermove', childBody, 120, 183, { pointerId: 103 });
  assert.equal(phases.at(-1), 'swipe');
  pointer(root, 'pointerup', childBody, 120, 183, { pointerId: 103 });

  pointer(root, 'pointerdown', handle, 100, 220, { pointerId: 104 });
  await wait(15);
  assert.equal(phases.at(-1), 'drag');
  pointer(root, 'pointercancel', handle, 100, 220, { pointerId: 104 });
  assert.equal(phases.at(-1), 'drag');

  pointer(root, 'pointerdown', childBody, 100, 260, { pointerId: 105 });
  pointer(root, 'pointercancel', childBody, 100, 260, { pointerId: 105 });
  assert.equal(phases.at(-1), 'cancel');
  controller.dispose();
});

test('delegated title long press renames once and suppresses native click', async () => {
  const { root, parentTitle } = makeRows();
  let renamed = 0;
  let taps = 0;
  const controller = createGestureController(root, { longPressDuration: 8, onRename: () => { renamed += 1; }, onTap: () => { taps += 1; } });
  pointer(root, 'pointerdown', parentTitle, 100, 100, { pointerId: 2 });
  await wait(15);
  pointer(root, 'pointerup', parentTitle, 100, 100, { pointerId: 2 });
  pointer(root, 'click', parentTitle, 100, 100, { pointerId: 2 });
  assert.equal(renamed, 1);
  assert.equal(taps, 0);
  controller.dispose();
});

test('delegated title swipe follows raw dx and commits once', () => {
  const { root, child, childBody } = makeRows();
  const moves = [];
  let committed = 0;
  const controller = createGestureController(root, { onSwipeVisual: ({ phase, dx }) => { if (phase === 'move') moves.push(dx); }, onSwipe: () => { committed += 1; } });
  pointer(root, 'pointerdown', childBody, 200, 200, { pointerId: 3 });
  const move = pointer(root, 'pointermove', childBody, 160, 204, { pointerId: 3 });
  pointer(root, 'pointermove', childBody, 120, 204, { pointerId: 3 });
  pointer(root, 'pointerup', childBody, 120, 204, { pointerId: 3 });
  assert.equal(move.defaultPrevented, true);
  assert.deepEqual(moves, [-40, -80]);
  assert.equal(committed, 1);
  assert.equal(child.classList.contains('is-swiping'), false);
  controller.dispose();
});

test('controller uses gesture duration for swipe velocity and commits only deliberate gestures', () => {
  const previousWindow = globalThis.window;
  globalThis.window = { innerWidth: 400 };
  try {
    const { root, childBody } = makeRows();
    let clock = 0;
    const swipes = [];
    const controller = createGestureController(root, { now: () => clock, onSwipe: ({ direction }) => swipes.push(direction) });
    const run = (pointerId, startX, startY, moveX, moveY, startTime, moveTime, endTime) => {
      clock = startTime;
      pointer(root, 'pointerdown', childBody, startX, startY, { pointerId });
      clock = moveTime;
      pointer(root, 'pointermove', childBody, moveX, moveY, { pointerId });
      clock = endTime;
      pointer(root, 'pointerup', childBody, moveX, moveY, { pointerId });
      pointer(root, 'click', childBody, moveX, moveY, { pointerId });
    };
    run(11, 200, 200, 128, 200, 0, 75, 150); // 72px / 150ms
    run(12, 200, 200, 128, 200, 1000, 1500, 3000); // 72px / 2000ms
    run(13, 200, 200, 70, 200, 4000, 5000, 6000); // 130px / 2000ms
    run(14, 200, 200, 70, 305, 7000, 7500, 9000); // invalid angle
    run(15, 200, 200, 150, 200, 10000, 10001, 10001); // fast but too short
    run(16, 28, 200, -52, 200, 11000, 11010, 11020); // exact edge guard
    assert.deepEqual(swipes, ['left', 'left']);
    controller.dispose();
  } finally {
    if (previousWindow) globalThis.window = previousWindow; else delete globalThis.window;
  }
});

test('active, completed, and right swipes each invoke one mutation callback', () => {
  const { root, child, childBody } = makeRows();
  let clock = 0;
  const mutations = [];
  const controller = createGestureController(root, { now: () => clock, onSwipe: ({ row, direction }) => mutations.push(`${row.dataset.itemId}:${row.dataset.status ?? 'active'}:${direction}`) });
  const run = (pointerId, status, endX) => {
    child.dataset.status = status;
    clock += 1;
    pointer(root, 'pointerdown', childBody, 200, 200, { pointerId });
    clock += 50;
    pointer(root, 'pointermove', childBody, endX, 200, { pointerId });
    clock += 50;
    pointer(root, 'pointerup', childBody, endX, 200, { pointerId });
    pointer(root, 'click', childBody, endX, 200, { pointerId });
  };
  run(21, 'active', 120);
  run(22, 'completed', 120);
  run(23, 'active', 280);
  assert.deepEqual(mutations, ['child:active:left', 'child:completed:left', 'child:active:right']);
  assert.equal(controller.getSessionCount(), 0);
  controller.dispose();
});

test('drag follows raw pointer coordinates and marks the after insertion edge', async () => {
  const { root, parent, child, handle } = makeRows();
  const moves = [];
  const controller = createGestureController(root, {
    longPressDuration: 8,
    onDragStart: ({ row }) => { row.classList.add('dragging'); return true; },
    resolveDragTarget: () => ({ id: 'child', beforeId: null, position: 'after', allowed: true, row: child }),
    onDragMove: ({ row, x, y }) => {
      moves.push({ x, y });
      row.style.setProperty('--drag-x', `${x - 100}px`);
      row.style.setProperty('--drag-y', `${y - 100}px`);
    },
  });
  pointer(root, 'pointerdown', handle, 100, 100, { pointerId: 70 });
  await wait(15);
  pointer(root, 'pointermove', handle, 137, 224, { pointerId: 70 });
  assert.deepEqual(moves, [{ x: 137, y: 224 }]);
  assert.equal(parent.classList.contains('dragging'), true);
  assert.equal(parent.style['--drag-x'], '37px');
  assert.equal(parent.style['--drag-y'], '124px');
  assert.equal(child.classList.contains('drag-target'), true);
  assert.equal(child.classList.contains('drag-target-after'), true);
  assert.equal(child.classList.contains('drag-target-before'), false);
  pointer(root, 'pointerup', child, 137, 224, { pointerId: 70 });
  assert.equal(parent.classList.contains('dragging'), false);
  assert.equal(child.classList.contains('drag-target-after'), false);
  assert.equal(parent.style['--drag-x'], undefined);
  assert.equal(parent.style['--drag-y'], undefined);
  controller.dispose();
});

test('handle drag remains delegated after source row is detached and commits once', async () => {
  const { root, parent, child, handle } = makeRows();
  let starts = 0;
  let moves = 0;
  let ends = 0;
  let target = null;
  const controller = createGestureController(root, {
    longPressDuration: 8,
    onDragStart: () => { starts += 1; return true; },
    onDragMove: () => { moves += 1; },
    resolveDragTarget: () => ({ id: 'child', allowed: true, row: child }),
    onDragEnd: ({ target: value }) => { ends += 1; target = value?.id; },
  });
  pointer(root, 'pointerdown', handle, 100, 100, { pointerId: 4 });
  await wait(15);
  root.removeChild(parent);
  pointer(root, 'pointermove', child, 100, 220, { pointerId: 4 });
  pointer(root, 'pointerup', child, 100, 220, { pointerId: 4 });
  assert.equal(starts, 1);
  assert.equal(moves, 1);
  assert.equal(ends, 1);
  assert.equal(target, 'child');
  assert.equal(controller.getSessionCount(), 0);
  controller.dispose();
});

test('touch handle drag captures the original handle even at the system edge', async () => {
  const previousWindow = globalThis.window;
  globalThis.window = { innerWidth: 390 };
  try {
    const { root, child, handle } = makeRows();
    let starts = 0;
    let ends = 0;
    const controller = createGestureController(root, {
      longPressDuration: 8,
      onDragStart: () => { starts += 1; return true; },
      resolveDragTarget: () => ({ id: 'child', allowed: true, row: child }),
      onDragEnd: () => { ends += 1; },
    });
    pointer(root, 'pointerdown', handle, 12, 100, { pointerId: 40, pointerType: 'touch' });
    await wait(15);
    assert.equal(handle.capture.has(40), true);
    pointer(root, 'pointermove', handle, 60, 180, { pointerId: 40, pointerType: 'touch' });
    pointer(root, 'pointerup', child, 60, 180, { pointerId: 40, pointerType: 'touch' });
    assert.equal(starts, 1);
    assert.equal(ends, 1);
    assert.equal(controller.getSessionCount(), 0);
    controller.dispose();
  } finally {
    if (previousWindow) globalThis.window = previousWindow; else delete globalThis.window;
  }
});

test('virtual-list style drag auto-scroll continues while the pointer is stationary near an edge', async () => {
  const previousFrame = globalThis.requestAnimationFrame;
  const previousCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  globalThis.cancelAnimationFrame = (frame) => clearTimeout(frame);
  try {
    const { root, child, handle } = makeRows();
    const scrollContainer = { scrollTop: 0, scrollHeight: 600, clientHeight: 200, getBoundingClientRect: () => ({ top: 100, bottom: 500 }) };
    const controller = createGestureController(root, {
      longPressDuration: 8,
      onDragStart: () => true,
      resolveDragTarget: () => ({ id: 'child', allowed: true, row: child }),
      getScrollContainer: () => scrollContainer,
    });
    pointer(root, 'pointerdown', handle, 100, 100, { pointerId: 6 });
    await wait(15);
    pointer(root, 'pointermove', handle, 100, 495, { pointerId: 6 });
    await wait(15);
    assert.ok(scrollContainer.scrollTop > 0);
    pointer(root, 'pointerup', handle, 100, 495, { pointerId: 6 });
    controller.dispose();
  } finally {
    if (previousFrame) globalThis.requestAnimationFrame = previousFrame; else delete globalThis.requestAnimationFrame;
    if (previousCancel) globalThis.cancelAnimationFrame = previousCancel; else delete globalThis.cancelAnimationFrame;
  }
});

test('virtual-list drag keeps the original viewport after the source row unmounts', async () => {
  const previousFrame = globalThis.requestAnimationFrame;
  const previousCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  globalThis.cancelAnimationFrame = (frame) => clearTimeout(frame);
  try {
    const root = new FakeElement({ className: 'app-root' });
    const viewport = new FakeElement({ className: 'virtual-viewport' });
    viewport.scrollTop = 0;
    viewport.scrollHeight = 20000;
    viewport.clientHeight = 200;
    viewport.getBoundingClientRect = () => ({ top: 100, bottom: 500 });
    const pageScroll = { scrollTop: 0, scrollHeight: 20000, clientHeight: 800, getBoundingClientRect: () => ({ top: 0, bottom: 800 }) };
    const source = new FakeElement({ className: 'item-row', dataset: { itemId: 'source', gestureContext: 'tree', hasChildren: 'false' } });
    const handle = new FakeElement({ tagName: 'BUTTON', dataset: { gestureZone: GESTURE_ZONES.handle } });
    source.append(handle);
    const targetRow = new FakeElement({ className: 'item-row', dataset: { itemId: 'target', gestureContext: 'tree', hasChildren: 'false' } });
    viewport.append(source, targetRow);
    root.append(viewport);
    let containerLookups = 0;
    let endCount = 0;
    let endTarget = null;
    const controller = createGestureController(root, {
      longPressDuration: 8,
      onDragStart: () => true,
      getScrollContainer: ({ row }) => {
        containerLookups += 1;
        return row.parentNode ? viewport : pageScroll;
      },
      resolveDragTarget: () => ({ id: 'target', allowed: true, row: targetRow }),
      onDragEnd: ({ target }) => { endCount += 1; endTarget = target?.id ?? null; },
    });
    pointer(root, 'pointerdown', handle, 100, 100, { pointerId: 30 });
    await wait(15);
    pointer(root, 'pointermove', handle, 100, 495, { pointerId: 30 });
    viewport.removeChild(source);
    await wait(35);
    assert.equal(source.parentNode, null);
    assert.equal(containerLookups, 1);
    assert.ok(viewport.scrollTop > 0);
    assert.equal(pageScroll.scrollTop, 0);
    pointer(root, 'pointerup', targetRow, 100, 495, { pointerId: 30 });
    assert.equal(endCount, 1);
    assert.equal(endTarget, 'target');
    assert.equal(controller.getSessionCount(), 0);
    const settled = viewport.scrollTop;
    await wait(15);
    assert.equal(viewport.scrollTop, settled);
    controller.dispose();
  } finally {
    if (previousFrame) globalThis.requestAnimationFrame = previousFrame; else delete globalThis.requestAnimationFrame;
    if (previousCancel) globalThis.cancelAnimationFrame = previousCancel; else delete globalThis.cancelAnimationFrame;
  }
});

test('destroyed drag viewport cancels instead of falling back to page scrolling', async () => {
  const previousFrame = globalThis.requestAnimationFrame;
  const previousCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  globalThis.cancelAnimationFrame = (frame) => clearTimeout(frame);
  try {
    const root = new FakeElement({ className: 'app-root' });
    const viewport = new FakeElement({ className: 'virtual-viewport' });
    viewport.scrollTop = 0;
    viewport.scrollHeight = 20000;
    viewport.clientHeight = 200;
    viewport.getBoundingClientRect = () => ({ top: 100, bottom: 500 });
    const source = new FakeElement({ className: 'item-row', dataset: { itemId: 'source', gestureContext: 'tree', hasChildren: 'false' } });
    const handle = new FakeElement({ tagName: 'BUTTON', dataset: { gestureZone: GESTURE_ZONES.handle } });
    source.append(handle); viewport.append(source); root.append(viewport);
    let cancelled = 0;
    let ended = 0;
    const controller = createGestureController(root, {
      longPressDuration: 8,
      onDragStart: () => true,
      getScrollContainer: () => viewport,
      onCancel: () => { cancelled += 1; },
      onDragEnd: () => { ended += 1; },
    });
    pointer(root, 'pointerdown', handle, 100, 100, { pointerId: 31 });
    await wait(15);
    pointer(root, 'pointermove', handle, 100, 495, { pointerId: 31 });
    root.removeChild(viewport);
    await wait(15);
    assert.equal(cancelled, 1);
    assert.equal(ended, 0);
    assert.equal(controller.getSessionCount(), 0);
    pointer(root, 'pointerup', root, 100, 495, { pointerId: 31 });
    controller.dispose();
  } finally {
    if (previousFrame) globalThis.requestAnimationFrame = previousFrame; else delete globalThis.requestAnimationFrame;
    if (previousCancel) globalThis.cancelAnimationFrame = previousCancel; else delete globalThis.cancelAnimationFrame;
  }
});

test('outside pointer callback is one delegated listener and Escape cancels active stream', () => {
  const { root, childBody } = makeRows();
  let outside = 0;
  const controller = createGestureController(root, { onOutsidePointerDown: () => { outside += 1; } });
  pointer(root, 'pointerdown', childBody, 100, 100, { pointerId: 5 });
  pointer(root, 'keydown', childBody, 100, 100, { key: 'Escape', pointerId: 5 });
  assert.equal(outside, 1);
  assert.equal(controller.getSessionCount(), 0);
  controller.dispose();
});
