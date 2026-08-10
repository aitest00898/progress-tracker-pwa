import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

async function files(directory) {
  const names = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const name of names) {
    const path = join(directory, name.name);
    if (name.isDirectory() && name.name !== 'node_modules' && name.name !== 'dist') result.push(...await files(path));
    else if (name.isFile() && path.endsWith('.js')) result.push(path);
  }
  return result;
}

const sourceFiles = [...await files('src'), ...await files('scripts')];
let failed = false;
for (const file of sourceFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) { failed = true; process.stderr.write(result.stderr); }
}
const forbidden = [/\bTODO\b/, /\bFIXME\b/];
for (const file of sourceFiles) {
  const text = await (await import('node:fs/promises')).readFile(file, 'utf8');
  for (const pattern of forbidden) if (pattern.test(text)) { failed = true; console.error(`${file}: forbidden unfinished marker ${pattern}`); }
}
if (failed) process.exit(1);
console.log(`lint ok: ${sourceFiles.length} JavaScript files syntax-checked`);
