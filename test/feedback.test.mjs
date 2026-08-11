import test from 'node:test';
import assert from 'node:assert/strict';
import { FEEDBACK_MODES, mutationFeedback } from '../src/feedback.js';

test('visible mutations use inline or no success feedback instead of a redundant toast', () => {
  assert.equal(mutationFeedback('complete', 'itemCompleted'), FEEDBACK_MODES.none);
  assert.equal(mutationFeedback('priority_changed', 'priorityChanged'), FEEDBACK_MODES.none);
  assert.equal(mutationFeedback('today_batch_complete', 'itemCompleted'), FEEDBACK_MODES.none);
  assert.equal(mutationFeedback('edit_title', 'savedOffline'), FEEDBACK_MODES.none);
});

test('off-screen and background results retain a concise toast channel', () => {
  assert.equal(mutationFeedback('move', 'itemMoved'), FEEDBACK_MODES.toast);
  assert.equal(mutationFeedback('duplicate', 'duplicateSuccess'), FEEDBACK_MODES.toast);
  assert.equal(mutationFeedback('backup_created', 'backupCreated'), FEEDBACK_MODES.toast);
  assert.equal(mutationFeedback('restore', 'restoredMessage'), FEEDBACK_MODES.toast);
});

test('explicit feedback mode is validated and unsupported modes do not leak into the UI', () => {
  assert.equal(mutationFeedback('delete', 'itemDeleted', FEEDBACK_MODES.undoToast), FEEDBACK_MODES.undoToast);
  assert.equal(mutationFeedback('delete', 'itemDeleted', 'popup'), FEEDBACK_MODES.none);
  assert.equal(mutationFeedback('delete', null), FEEDBACK_MODES.none);
});
