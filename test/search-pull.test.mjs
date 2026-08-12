import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SEARCH_PULL_CONFIG, canStartSearchPull, createSearchPullSession, resolveSearchPullRelease, shouldCaptureSearchPull, updateSearchPullSession,
} from '../src/search-pull.js';

test('only the top affordance can claim search pull; row scrolling stays native', () => {
  assert.equal(canStartSearchPull({ isAffordance: false, scrollTop: 0 }), false);
  assert.equal(canStartSearchPull({ isAffordance: true, scrollTop: 0 }), true);
  assert.equal(canStartSearchPull({ isAffordance: true, scrollTop: 1 }), false);
  assert.equal(canStartSearchPull({ isAffordance: true, scrollTop: 0, isControl: true }), false);
});

test('top pull follows vertical distance and opens only after threshold', () => {
  const session = createSearchPullSession({ pointerId: 1, mode: 'open', startX: 100, startY: 0 });
  let result = updateSearchPullSession(session, { x: 101, y: 30 });
  assert.equal(result.axis, 'vertical');
  assert.equal(result.distance, 30);
  assert.equal(resolveSearchPullRelease(result.session), 'closed');
  result = updateSearchPullSession(result.session, { x: 101, y: SEARCH_PULL_CONFIG.threshold + 1 });
  assert.equal(result.distance, SEARCH_PULL_CONFIG.threshold + 1);
  assert.equal(resolveSearchPullRelease(result.session), 'open');
});

test('horizontal row-like motion is not claimed by search', () => {
  const session = createSearchPullSession({ pointerId: 2, mode: 'open', startX: 0, startY: 0 });
  const result = updateSearchPullSession(session, { x: 40, y: 12 });
  assert.equal(result.cancelled, true);
  assert.equal(result.axis, 'horizontal');
  assert.equal(resolveSearchPullRelease(result.session), 'closed');
});

test('open drawer closes only after an upward close threshold', () => {
  const session = createSearchPullSession({ pointerId: 3, mode: 'close', startX: 0, startY: 100 });
  let result = updateSearchPullSession(session, { x: 0, y: 70 });
  assert.equal(result.distance, 30);
  assert.equal(resolveSearchPullRelease(result.session), 'open');
  result = updateSearchPullSession(result.session, { x: 0, y: 100 - SEARCH_PULL_CONFIG.closeThreshold });
  assert.equal(resolveSearchPullRelease(result.session), 'closed');
});

test('search delays pointer capture until a downward pull is claimed', () => {
  const session = createSearchPullSession({ pointerId: 4, mode: 'open', startX: 100, startY: 100 });
  const upward = updateSearchPullSession(session, { x: 100, y: 40 });
  assert.equal(upward.claimed, false);
  assert.equal(shouldCaptureSearchPull(session, upward), false);

  const downward = updateSearchPullSession(session, { x: 100, y: 112 });
  assert.equal(downward.claimed, true);
  assert.equal(shouldCaptureSearchPull(session, downward), true);
  assert.equal(shouldCaptureSearchPull(downward.session, updateSearchPullSession(downward.session, { x: 100, y: 140 })), false);
});
