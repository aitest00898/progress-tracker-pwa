import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySwipeAxis, shouldTriggerSwipe, swipeDirection, swipeOffset } from '../src/swipe.js';

test('swipe axis locks to horizontal only after a clear horizontal intent', () => {
  assert.equal(classifySwipeAxis(4, 2), 'undecided');
  assert.equal(classifySwipeAxis(30, 8), 'horizontal');
  assert.equal(classifySwipeAxis(8, 30), 'vertical');
  assert.equal(classifySwipeAxis(20, 18), 'undecided');
});

test('swipe action thresholds accept a deliberate mobile gesture without stealing scroll', () => {
  assert.equal(shouldTriggerSwipe(-80, 8, 360), true);
  assert.equal(shouldTriggerSwipe(80, 70, 360), false);
  assert.equal(shouldTriggerSwipe(60, 0, 360), false);
  assert.equal(swipeDirection(-1), 'left');
  assert.equal(swipeDirection(1), 'right');
});

test('live swipe offset follows the finger but remains bounded', () => {
  assert.equal(swipeOffset(40, 320), 40);
  assert.equal(swipeOffset(-500, 320), -148);
  assert.equal(swipeOffset(500, 320), 148);
});
