import test from 'node:test';
import assert from 'node:assert/strict';
import { clampTreeDepth, treeRowClassNames, treeRowMetrics, treeRowSemantics } from '../src/tree-view.js';

test('state-derived row cues distinguish parent progress from leaf state', () => {
  const parent = treeRowSemantics({ childCount: 2, depth: 0, tree: true, nextDepth: 1 });
  const child = treeRowSemantics({ childCount: 0, depth: 1, tree: true, nextDepth: null });

  assert.equal(parent.kind, 'parent');
  assert.equal(parent.typeCue, 'progress-ring');
  assert.equal(parent.hasProgressRing, true);
  assert.equal(parent.hasStateCircle, false);
  assert.equal(parent.depth, 0);
  assert.equal(parent.hasConnector, false);
  assert.equal(child.kind, 'leaf');
  assert.equal(child.typeCue, 'state-circle');
  assert.equal(child.hasProgressRing, false);
  assert.equal(child.hasStateCircle, true);
  assert.equal(child.depth, 1);
  assert.equal(child.hasConnector, true);
  assert.match(treeRowClassNames(parent), /tree-root/);
  assert.match(treeRowClassNames(child), /tree-child/);
});

test('responsive visual depth is capped without changing the source hierarchy depth', () => {
  const deep = treeRowSemantics({ childCount: 0, depth: 7, maxDepth: 2, sourceDepth: 7, tree: true });
  assert.equal(clampTreeDepth(7, 2), 2);
  assert.equal(deep.depth, 2);
  assert.equal(deep.sourceDepth, 7);
  assert.equal(deep.hasConnector, true);
});

test('flat contextual rows never draw tree connectors', () => {
  const search = treeRowSemantics({ childCount: 3, depth: 4, tree: false, pathContext: true, nextDepth: 5 });
  const smart = treeRowSemantics({ childCount: 3, depth: 4, tree: true, smartView: 'today', nextDepth: 5 });
  assert.equal(search.isTreeRow, false);
  assert.equal(search.hasConnector, false);
  assert.equal(search.depth, 0);
  assert.equal(smart.isTreeRow, false);
  assert.equal(smart.hasConnector, false);
  assert.equal(smart.spacing, 'flat');
  assert.equal(treeRowClassNames(search), 'flat-row');
});

test('tree spacing keeps descendants compact and separates root groups', () => {
  const rootToChild = treeRowSemantics({ childCount: 1, depth: 0, tree: true, nextDepth: 1 });
  const sibling = treeRowSemantics({ childCount: 0, depth: 1, tree: true, nextDepth: 1 });
  const lastChildToRoot = treeRowSemantics({ childCount: 0, depth: 1, tree: true, nextDepth: 0 });
  const rootMetrics = treeRowMetrics(rootToChild);
  const siblingMetrics = treeRowMetrics(sibling);
  const groupMetrics = treeRowMetrics(lastChildToRoot);

  assert.equal(rootToChild.spacing, 'parent-child');
  assert.equal(sibling.spacing, 'tree-sibling');
  assert.equal(lastChildToRoot.spacing, 'tree-group');
  assert.equal(rootMetrics.gap, 10);
  assert.equal(siblingMetrics.gap, 8);
  assert.equal(groupMetrics.gap, 28);
  assert.ok(siblingMetrics.height < rootMetrics.height);
});

test('completed descendants retain tree connector semantics', () => {
  const completedChild = treeRowSemantics({ childCount: 0, depth: 1, tree: true, nextDepth: 0 });
  assert.equal(completedChild.hasConnector, true);
  assert.equal(completedChild.isTreeRow, true);
  assert.equal(completedChild.spacing, 'tree-group');
});

