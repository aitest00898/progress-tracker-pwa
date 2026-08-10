# Progress Tracker PWA performance report

Measured on 2026-08-10 with Node v22.23.1. The benchmark is deterministic and can be rerun with:

```sh
npm run benchmark -- --samples 5
npm run benchmark -- --items 10000 --samples 3
```

## Workload

- 2,500 items across 5 categories
- 10,150 activity-history rows
- balanced hierarchy with depth 4, inherited and explicit due dates, mixed status, tags, notes and Today membership
- one warm-up followed by 5 measured samples; table values are medians

## Before and after

| Operation | Before | After | Reduction | Speed-up | Final p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Descendant traversal | 6.361 ms | 0.562 ms | 91.2% | 11.3x | 0.828 ms |
| Recursive progress | 5.811 ms | 0.657 ms | 88.7% | 8.8x | 0.865 ms |
| Text/path/tag search | 19.727 ms | 2.269 ms | 88.5% | 8.7x | 2.728 ms |
| Today calculation | 25.521 ms | 1.742 ms | 93.2% | 14.7x | 2.525 ms |
| Ready to Close | 102.185 ms | 4.502 ms | 95.6% | 22.7x | 5.373 ms |
| Stale | 58.352 ms | 4.442 ms | 92.4% | 13.1x | 4.767 ms |
| Routine suggestions | 132.872 ms | 3.903 ms | 97.1% | 34.0x | 3.931 ms |
| Recently Active | 4.631 ms | 3.894 ms | 15.9% | 1.2x | 4.220 ms |

Result digests were unchanged before and after, so the benchmarked outputs remained equivalent.

## 10,000-item scaling check

The same optimized implementation was also measured with 10,000 items, 40,600 history rows and hierarchy depth 5:

| Operation | Median | p95 |
| --- | ---: | ---: |
| Descendant traversal | 2.811 ms | 3.212 ms |
| Recursive progress | 1.789 ms | 2.235 ms |
| Search | 9.801 ms | 10.611 ms |
| Today | 8.136 ms | 10.115 ms |
| Ready to Close | 17.962 ms | 20.847 ms |
| Stale | 18.032 ms | 25.204 ms |
| Routine suggestions | 17.499 ms | 18.040 ms |
| Recently Active | 16.758 ms | 17.185 ms |

The hot paths now scale approximately linearly with item and history count instead of repeatedly scanning the full dataset for each item.

## Bottlenecks found

1. Item, parent and child lookups repeatedly scanned the complete `items` array.
2. Search rebuilt every ancestor path through repeated linear lookups.
3. Today recalculated inherited due dates multiple times per item and used array membership checks for overdue filtering.
4. Ready to Close discarded the progress memo for every candidate item.
5. Stale and Routine views filtered the complete history array once per item.
6. Tree rendering repeated child/history/reminder/conflict scans despite list virtualization.
7. Virtual-list scroll handling replaced every visible row on each scroll frame, even when the visible range had not changed; search results were not virtualized.

## Changes made

- Added a single-pass engine index for items, categories, parent-child edges, histories, reminders and conflicts.
- Added shared caches for effective due, contextual planned start, hierarchy paths and recursive progress.
- Reused the same index and caches across each Smart View, Today, search and render pass.
- Replaced queue `shift()` traversal with a cursor and replaced overdue array membership checks with a `Set`.
- Reused a single render timestamp so sorting and date classification do not allocate a new `Date` for each comparison.
- Connected the index to category counts, Tree flattening, visible rows, Reminder Center and Item Detail.
- Virtualized search results and skipped DOM replacement while scrolling inside an unchanged virtual range.
- Added automated 2,500-item p95 regression budgets and virtual-window boundary tests.

## Browser verification

Production-browser smoke data contained 60 real Items. Both Tree and Search rendered 26 virtual rows rather than 60 Item DOM rows. Today and Smart Views opened normally, the final bundle produced no console errors, and no `null` UI text was present.

## Bundle impact

- Before: 185.53 kB JavaScript, 55.62 kB gzip
- After: 188.22 kB JavaScript, 56.42 kB gzip
- Cost: +0.80 kB gzip for indexing and regression instrumentation

The small bundle increase is outweighed by the 8.7x to 34.0x improvement on the previously slow 2,500-item hot paths.
