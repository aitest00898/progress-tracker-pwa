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
