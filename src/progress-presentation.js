import { formatProgress } from './engine.js';

/**
 * The one presentation boundary for progress values. Engine progress remains
 * raw/derived data; this helper is the only place where a row/detail label is
 * produced, so an incomplete 99.95% value cannot be displayed as 100%.
 *
 * @param {{raw?: number, complete?: boolean}|number} result
 * @param {boolean} [complete]
 * @returns {{numeric: number, label: string}}
 */
export function progressPresentation(result, complete = false) {
  const isResult = result && typeof result === 'object';
  const numeric = formatProgress(isResult ? result.raw : result, isResult ? Boolean(result.complete) : complete);
  return { numeric, label: `${numeric}%` };
}

/** @param {{raw?: number, complete?: boolean}|number} result @param {boolean} [complete] */
export function progressLabel(result, complete = false) {
  return progressPresentation(result, complete).label;
}
