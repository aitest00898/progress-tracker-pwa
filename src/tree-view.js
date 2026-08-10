const DEFAULT_TREE_MAX_DEPTH = 2;

export function clampTreeDepth(depth, maxDepth = DEFAULT_TREE_MAX_DEPTH) {
  const numericDepth = Number.isFinite(Number(depth)) ? Math.max(0, Math.floor(Number(depth))) : 0;
  const numericMax = Number.isFinite(Number(maxDepth)) ? Math.max(0, Math.floor(Number(maxDepth))) : DEFAULT_TREE_MAX_DEPTH;
  return Math.min(numericDepth, numericMax);
}

export function treeRowSemantics({
  childCount = 0,
  depth = 0,
  sourceDepth = depth,
  maxDepth = DEFAULT_TREE_MAX_DEPTH,
  tree = true,
  pathContext = false,
  smartView = null,
  siblingIndex = 0,
  siblingCount = 1,
  nextDepth = null,
} = {}) {
  const isTreeRow = Boolean(tree && !pathContext && !smartView);
  const isParent = Number(childCount) > 0;
  const displayedDepth = isTreeRow ? clampTreeDepth(depth, maxDepth) : 0;
  const numericSiblingIndex = Math.max(0, Number.isFinite(Number(siblingIndex)) ? Math.floor(Number(siblingIndex)) : 0);
  const numericSiblingCount = Math.max(1, Number.isFinite(Number(siblingCount)) ? Math.floor(Number(siblingCount)) : 1);
  const normalizedNextDepth = nextDepth === null || nextDepth === undefined || nextDepth === '' ? null : Math.max(0, Math.floor(Number(nextDepth)));
  let spacing = 'flat';
  if (isTreeRow) {
    if (normalizedNextDepth === null || normalizedNextDepth === 0) spacing = 'tree-group';
    else if (normalizedNextDepth > displayedDepth) spacing = 'parent-child';
    else spacing = 'tree-sibling';
  }
  const hasProgressRing = isParent && !smartView;
  return {
    isTreeRow,
    isParent,
    isLeaf: !isParent,
    kind: isParent ? 'parent' : 'leaf',
    typeCue: hasProgressRing ? 'progress-ring' : 'state-circle',
    hasProgressRing,
    hasStateCircle: !hasProgressRing,
    sourceDepth: Math.max(0, Number.isFinite(Number(sourceDepth)) ? Math.floor(Number(sourceDepth)) : 0),
    depth: displayedDepth,
    hasConnector: isTreeRow && displayedDepth > 0,
    siblingIndex: numericSiblingIndex,
    siblingCount: numericSiblingCount,
    isLastSibling: numericSiblingIndex >= numericSiblingCount - 1,
    nextDepth: normalizedNextDepth,
    spacing,
  };
}

export function treeRowClassNames(semantics) {
  if (!semantics.isTreeRow) return 'flat-row';
  return [
    'tree-row',
    semantics.depth === 0 ? 'tree-root' : 'tree-child',
    semantics.isParent ? 'has-children' : 'is-leaf',
    semantics.hasConnector ? 'has-connector' : '',
  ].filter(Boolean).join(' ');
}

export function treeRowMetrics(semantics, { quickActions = false, hoverActions = false } = {}) {
  if (!semantics.isTreeRow) return { height: 116, gap: 8 };
  const mainHeight = semantics.depth === 0 ? 88 : semantics.hasProgressRing ? 66 : 64;
  const actionHeight = hoverActions ? 48 : 0;
  const height = mainHeight + actionHeight + (quickActions ? 58 : 0);
  const gap = semantics.spacing === 'tree-group' ? 28 : semantics.spacing === 'parent-child' ? 10 : 8;
  return { height, gap };
}
