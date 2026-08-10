import { spawnSync } from 'node:child_process';

const modules = ['appearance.js', 'schema.js', 'engine-index.js', 'engine.js', 'ptmd.js', 'sync.js', 'diagnostics.js', 'i18n.js', 'markdown.js', 'migration.js', 'virtual-list.js', 'tree-view.js', 'swipe.js', 'db.js', 'storage.js', 'storage-metrics.js'];
let failed = false;
for (const module of modules) {
  const result = spawnSync(process.execPath, ['-e', `import('./src/${module}').then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); })`], { encoding: 'utf8' });
  if (result.status !== 0) { failed = true; process.stderr.write(result.stderr || result.stdout); }
}
if (failed) process.exit(1);
console.log(`typecheck ok: ${modules.length} domain modules imported successfully`);
