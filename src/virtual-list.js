export function virtualRange({ itemCount, scrollTop, viewportHeight, rowHeight, overscan }) {
  const first = Math.min(itemCount, Math.max(0, Math.floor(Math.max(0, scrollTop) / rowHeight) - overscan));
  const visibleCount = Math.ceil(Math.max(0, viewportHeight) / rowHeight) + overscan * 2;
  return { first, last: Math.min(itemCount, first + visibleCount) };
}

function itemAtOffset(offsets, value) {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (offsets[middle] <= value) low = middle;
    else high = middle - 1;
  }
  return Math.max(0, Math.min(offsets.length - 2, low));
}

export class VirtualList {
  /** @param {HTMLElement} container @param {{rowHeight?: number, overscan?: number, renderRow?: (item: any, index: number) => HTMLElement, empty?: () => Node, itemMetrics?: (item: any, index: number) => {height?: number, gap?: number}|null}} [options] */
  constructor(container, { rowHeight = 82, overscan = 8, renderRow, empty, itemMetrics = null } = {}) {
    this.container = container;
    this.rowHeight = rowHeight;
    this.overscan = overscan;
    this.renderRow = renderRow;
    this.empty = empty;
    this.itemMetrics = itemMetrics;
    this.items = [];
    this.metrics = null;
    this.offsets = [0];
    this.rangeKey = null;
    this.renderCount = 0;
    this.viewport = document.createElement('div');
    this.viewport.className = 'virtual-viewport';
    this.container.replaceChildren(this.viewport);
    this.container.classList.add('virtual-list');
    this.onScroll = () => this.scheduleRender();
    this.viewport.addEventListener('scroll', this.onScroll, { passive: true });
  }

  setItems(items) {
    this.items = items ?? [];
    this.rebuildMetrics();
    this.rangeKey = null;
    this.render();
  }

  rebuildMetrics() {
    if (!this.itemMetrics) {
      this.metrics = null;
      this.offsets = [0];
      return;
    }
    this.metrics = this.items.map((item, index) => {
      const result = this.itemMetrics(item, index) ?? {};
      const height = Number(result.height);
      const gap = Number(result.gap ?? 0);
      return {
        height: Number.isFinite(height) && height > 0 ? height : this.rowHeight,
        gap: Number.isFinite(gap) && gap >= 0 ? gap : 0,
      };
    });
    this.offsets = [0];
    for (const metric of this.metrics) this.offsets.push(this.offsets.at(-1) + metric.height + metric.gap);
  }

  scheduleRender() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); });
  }

  render() {
    if (!this.items.length) {
      if (this.rangeKey === 'empty') return;
      this.rangeKey = 'empty';
      this.viewport.replaceChildren(this.empty?.() ?? document.createElement('div'));
      return;
    }
    const scrollTop = this.viewport.scrollTop;
    const height = this.viewport.clientHeight || 600;
    let first;
    let last;
    let topHeight;
    let bottomHeight;
    if (this.metrics) {
      const visibleEnd = scrollTop + Math.max(0, height);
      first = Math.max(0, itemAtOffset(this.offsets, scrollTop) - this.overscan);
      last = Math.min(this.items.length, itemAtOffset(this.offsets, visibleEnd) + 1 + this.overscan);
      topHeight = this.offsets[first];
      bottomHeight = this.offsets[this.items.length] - this.offsets[last];
    } else {
      ({ first, last } = virtualRange({ itemCount: this.items.length, scrollTop, viewportHeight: height, rowHeight: this.rowHeight, overscan: this.overscan }));
      topHeight = first * this.rowHeight;
      bottomHeight = Math.max(0, (this.items.length - last) * this.rowHeight);
    }
    const rangeKey = `${first}:${last}:${this.items.length}:${this.metrics ? this.offsets[this.items.length] : this.rowHeight}`;
    if (rangeKey === this.rangeKey) return;
    this.rangeKey = rangeKey;
    this.renderCount += 1;
    const fragment = document.createDocumentFragment();
    const top = document.createElement('div'); top.style.height = `${topHeight}px`;
    const bottom = document.createElement('div'); bottom.style.height = `${bottomHeight}px`;
    fragment.append(top);
    for (let index = first; index < last; index += 1) {
      const row = this.renderRow(this.items[index], index);
      row.dataset.virtualIndex = String(index);
      if (this.metrics) {
        row.style.minHeight = `${this.metrics[index].height}px`;
        row.style.marginBottom = `${this.metrics[index].gap}px`;
      } else row.style.minHeight = `${this.rowHeight}px`;
      fragment.append(row);
    }
    fragment.append(bottom);
    this.viewport.replaceChildren(fragment);
  }

  /** @param {number} index @param {ScrollBehavior} [behavior] */
  scrollToIndex(index, behavior = 'smooth') {
    if (index < 0 || index >= this.items.length) return;
    this.viewport.scrollTo({ top: this.metrics ? this.offsets[index] : index * this.rowHeight, behavior });
  }

  destroy() {
    this.viewport.removeEventListener('scroll', this.onScroll);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.container.replaceChildren();
  }
}
