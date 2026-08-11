import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INTERACTION_CLASSES,
  INTERACTION_CONFIG,
  isRowPressCancellation,
} from '../src/interaction.js';

test('interaction tokens describe immediate press feedback and restrained release', () => {
  assert.equal(INTERACTION_CLASSES.controlPressed, 'is-pressed');
  assert.equal(INTERACTION_CLASSES.rowPressed, 'row-pressed');
  assert.equal(INTERACTION_CLASSES.swipeReleasing, 'swipe-releasing');
  assert.ok(INTERACTION_CONFIG.controlPressScale < 1);
  assert.ok(INTERACTION_CONFIG.releaseDurationMs > 0 && INTERACTION_CONFIG.releaseDurationMs < 250);
});

test('row press cancels when gesture ownership changes', () => {
  assert.equal(isRowPressCancellation('vertical'), true);
  assert.equal(isRowPressCancellation('swipe'), true);
  assert.equal(isRowPressCancellation('drag'), true);
  assert.equal(isRowPressCancellation('rename'), true);
  assert.equal(isRowPressCancellation('end'), false);
});
