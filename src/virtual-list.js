export function virtualRange({ itemCount, scrollTop, viewportHeight, rowHeight, overscan }) {
  const first = Math.min(itemCount, Math.max(0, Math.floor(Math.max(0, scrollTop) / rowHeight) - overscan));
  const visibleCount = Math.ceil(Math.max(0, viewportHeight) / rowHeight) + overscan * 2;
  return { first, last: Math.min(itemCount, first + visibleCount) };
}

export class VirtualList {
  constructor(container, { rowHeight = 82, overscan = 8, renderRow, empty } = {}) {
    this.container = container;
    this.rowHeight = rowHeight;
    this.overscan = overscan;
    this.renderRow = renderRow;
    this.empty = empty;
    this.items = [];
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
    this.rangeKey = null;
    this.render();
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
    const { first, last } = virtualRange({ itemCount: this.items.length, scrollTop, viewportHeight: height, rowHeight: this.rowHeight, overscan: this.overscan });
    const rangeKey = `${first}:${last}:${this.items.length}`;
    if (rangeKey === this.rangeKey) return;
    this.rangeKey = rangeKey;
    this.renderCount += 1;
    const fragment = document.createDocumentFragment();
    const top = document.createElement('div'); top.style.height = `${first * this.rowHeight}px`;
    const bottom = document.createElement('div'); bottom.style.height = `${Math.max(0, (this.items.length - last) * this.rowHeight)}px`;
    fragment.append(top);
    for (let index = first; index < last; index += 1) {
      const row = this.renderRow(this.items[index], index);
      row.dataset.virtualIndex = String(index);
      row.style.minHeight = `${this.rowHeight}px`;
      fragment.append(row);
    }
    fragment.append(bottom);
    this.viewport.replaceChildren(fragment);
  }

  scrollToIndex(index, behavior = 'smooth') {
    if (index < 0 || index >= this.items.length) return;
    this.viewport.scrollTo({ top: index * this.rowHeight, behavior });
  }

  destroy() {
    this.viewport.removeEventListener('scroll', this.onScroll);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.container.replaceChildren();
  }
}
