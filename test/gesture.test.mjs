import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GESTURE_CONFIG,
  GESTURE_STATES,
  GESTURE_ZONES,
  autoScrollSpeed,
  createGestureSession,
  gestureAxis,
  liveSwipeOffset,
  resolveInteractionPolicy,
  shouldCommitSwipe,
  shouldSuppressClick,
  stepGestureSession,
  swipeVelocity,
  validateReorderTarget,
} from '../src/gesture.js';

function step(session, type, x, y, time) {
  return stepGestureSession(session, { type, x, y, time });
}

test('policy assigns parent and leaf tap semantics without DOM assumptions', () => {
  const parent = resolveInteractionPolicy({ rowType: 'item', surface: 'tree', isParent: true });
  const leaf = resolveInteractionPolicy({ rowType: 'item', surface: 'tree', isParent: false });
  const search = resolveInteractionPolicy({ rowType: 'item', surface: 'search', isParent: true, pathContext: true });
  assert.equal(parent.titleTap, 'toggleExpanded');
  assert.equal(parent.bodyTap, 'toggleExpanded');
  assert.equal(leaf.bodyTap, 'quickActions');
  assert.equal(search.titleTap, 'focusOriginal');
  assert.equal(search.bodyTap, 'focusOriginal');
  assert.equal(resolveInteractionPolicy({ rowType: 'item', surface: 'detail', isParent: true }).bodyTap, 'toggleExpanded');
  assert.equal(parent.allowSwipe, true);
});

test('title tap and long press are mutually exclusive winners', () => {
  const title = createGestureSession({ pointerId: 1, pointerType: 'touch', zone: GESTURE_ZONES.title, policy: resolveInteractionPolicy({ isParent: true }) });
  const tap = step(title, 'up', 0, 0, 40);
  assert.equal(tap.effects[0].type, 'tap');
  assert.equal(tap.session.state, GESTURE_STATES.ended);

  let rename = createGestureSession({ pointerId: 2, pointerType: 'touch', zone: GESTURE_ZONES.title });
  rename = step(rename, 'longpress', 0, 0, 650).session;
  assert.equal(rename.state, GESTURE_STATES.renamingResolved);
  assert.equal(rename.winner, 'rename');
  assert.equal(shouldSuppressClick(rename), true);
  assert.deepEqual(step(rename, 'up', 0, 0, 700).effects, []);
});

test('title and body horizontal gestures commit only after angle and distance thresholds', () => {
  let title = createGestureSession({ pointerId: 3, pointerType: 'touch', zone: GESTURE_ZONES.title });
  title = step(title, 'move', -40, 4, 40).session;
  assert.equal(title.state, GESTURE_STATES.swiping);
  assert.equal(step(title, 'move', -55, 4, 60).effects.find((effect) => effect.type === 'swipeMove').dx, -55);
  const commit = step(title, 'up', -80, 5, 90);
  assert.equal(commit.effects[0].type, 'swipeCommit');
  assert.equal(commit.effects[0].direction, 'left');

  let body = createGestureSession({ pointerId: 4, pointerType: 'touch', zone: GESTURE_ZONES.body });
  body = step(body, 'move', 30, 28, 40).session;
  assert.equal(body.state, GESTURE_STATES.possible);
  body = step(body, 'move', 8, 30, 60).session;
  assert.equal(body.state, GESTURE_STATES.cancelled);
  assert.equal(step(body, 'up', 8, 30, 70).effects.length, 0);
  assert.equal(shouldCommitSwipe(80, 70, 20), false);
});

test('vertical title movement and body hold never resolve as rename', () => {
  let title = createGestureSession({ pointerId: 41, pointerType: 'touch', zone: GESTURE_ZONES.title });
  title = step(title, 'move', 3, 24, 40).session;
  assert.equal(title.state, GESTURE_STATES.cancelled);
  assert.deepEqual(step(title, 'longpress', 3, 24, 650).effects, []);

  let body = createGestureSession({ pointerId: 42, pointerType: 'touch', zone: GESTURE_ZONES.body });
  body = step(body, 'longpress', 0, 0, 650).session;
  assert.equal(body.winner, null);
  assert.equal(body.state, GESTURE_STATES.possible);
  assert.equal(step(body, 'up', 0, 0, 700).effects[0].type, 'tap');
});

test('handle touch waits for long press, mouse starts drag at a small movement', () => {
  let touch = createGestureSession({ pointerId: 5, pointerType: 'touch', zone: GESTURE_ZONES.handle });
  touch = step(touch, 'longpress', 0, 0, 650).session;
  assert.equal(touch.state, GESTURE_STATES.dragging);
  assert.equal(touch.winner, 'drag');
  assert.equal(step(touch, 'move', 4, 35, 700).session.state, GESTURE_STATES.dragging);
  assert.equal(step(touch, 'up', 4, 35, 740).effects[0].type, 'dragEnd');

  let mouse = createGestureSession({ pointerId: 6, pointerType: 'mouse', zone: GESTURE_ZONES.handle });
  mouse = step(mouse, 'move', 5, 0, 10).session;
  assert.equal(mouse.state, GESTURE_STATES.dragging);
  assert.equal(step(mouse, 'up', 5, 0, 20).effects[0].type, 'dragEnd');

  let pen = createGestureSession({ pointerId: 61, pointerType: 'pen', zone: GESTURE_ZONES.handle });
  pen = step(pen, 'move', 4, 0, 10).session;
  assert.equal(pen.state, GESTURE_STATES.possible);
  pen = step(pen, 'longpress', 4, 0, 650).session;
  assert.equal(pen.state, GESTURE_STATES.dragging);
});

test('reorder handle remains long-press eligible at the system edge', () => {
  let handle = createGestureSession({ pointerId: 62, pointerType: 'touch', zone: GESTURE_ZONES.handle, edgeGuarded: true });
  handle = step(handle, 'longpress', 0, 0, 650).session;
  assert.equal(handle.state, GESTURE_STATES.dragging);

  let title = createGestureSession({ pointerId: 63, pointerType: 'touch', zone: GESTURE_ZONES.title, edgeGuarded: true });
  title = step(title, 'longpress', 0, 0, 650).session;
  assert.equal(title.state, GESTURE_STATES.possible);
});

test('edge guard preserves horizontal list gestures for system navigation', () => {
  let session = createGestureSession({ pointerId: 7, pointerType: 'touch', zone: GESTURE_ZONES.body, edgeGuarded: true });
  session = step(session, 'move', -100, 0, 50).session;
  assert.equal(session.state, GESTURE_STATES.possible);
  assert.equal(step(session, 'up', -100, 0, 70).effects.length, 0);
});

test('live swipe motion is linear and velocity is measurable without changing it', () => {
  assert.equal(liveSwipeOffset(40), 40);
  assert.equal(liveSwipeOffset(-500), -128);
  assert.equal(swipeVelocity(-80, 200), 0.4);
  assert.equal(gestureAxis(-30, 8), 'horizontal');
  assert.equal(shouldCommitSwipe(-72, 0, 200), true);
});

test('swipe commit uses full gesture duration with velocity or deliberate long pull', () => {
  assert.equal(GESTURE_CONFIG.actionDistance, 72);
  assert.equal(GESTURE_CONFIG.minSwipeVelocity, 0.25);
  assert.equal(GESTURE_CONFIG.deliberateSwipeDistance, 120);
  assert.equal(shouldCommitSwipe(72, 0, 150), true, 'fast normal swipe commits');
  assert.equal(shouldCommitSwipe(72, 0, 2000), false, 'slow short swipe does not commit');
  assert.equal(shouldCommitSwipe(130, 0, 2000), true, 'slow deliberate long pull commits');
  assert.equal(shouldCommitSwipe(130, 105, 20), false, 'invalid vertical angle does not commit');
  assert.equal(shouldCommitSwipe(50, 0, 1), false, 'fast swipe below action distance does not commit');
});

test('ambiguous diagonal movement never falls back to a tap', () => {
  let session = createGestureSession({ pointerId: 81, pointerType: 'touch', zone: GESTURE_ZONES.body });
  session = step(session, 'move', -130, 105, 40).session;
  assert.equal(session.state, GESTURE_STATES.possible);
  assert.equal(session.moved, true);
  assert.deepEqual(step(session, 'up', -130, 105, 2000).effects, []);
});

test('cancel and repeated pointerup cannot produce a second mutation effect', () => {
  let session = createGestureSession({ pointerId: 8, pointerType: 'touch', zone: GESTURE_ZONES.body });
  session = step(session, 'move', -40, 0, 20).session;
  const cancelled = step(session, 'cancel', -40, 0, 25);
  assert.equal(cancelled.session.state, GESTURE_STATES.cancelled);
  assert.equal(cancelled.effects[0].type, 'cancel');
  const ended = step(cancelled.session, 'up', -80, 0, 40);
  assert.deepEqual(ended.effects, []);
});

test('reorder validation blocks cross-sibling and conflict mutations', () => {
  const source = { id: 'a', categoryId: 'c', parentId: null, status: 'active', conflicted: false };
  assert.equal(validateReorderTarget({ source, target: { ...source, id: 'b' } }).ok, true);
  assert.equal(validateReorderTarget({ source, target: { ...source, id: 'b', parentId: 'p' } }).reason, 'sibling_only');
  assert.equal(validateReorderTarget({ source: { ...source, conflicted: true }, target: { ...source, id: 'b' } }).reason, 'conflict');
  assert.equal(validateReorderTarget({ source, target: { ...source, id: 'b', parentId: 'p' }, mode: 'smart' }).ok, true);
});

test('edge autoscroll is bounded, directional, and idle in the middle', () => {
  assert.equal(autoScrollSpeed(300, 100, 500), 0);
  assert.equal(autoScrollSpeed(105, 100, 500), -16.5);
  assert.equal(autoScrollSpeed(495, 100, 500), 16.5);
  assert.equal(autoScrollSpeed(50, 100, 500), 0);
});
