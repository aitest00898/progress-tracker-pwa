import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) result.push(path);
  }
  return result;
}

const sourceFiles = [...await files('src'), ...await files('scripts'), ...await files('test')];
let failed = false;
for (const file of sourceFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(result.stderr || result.stdout || `${file}: syntax check failed\n`);
  }
}

const forbidden = [/\bTODO\b/, /\bFIXME\b/];
for (const file of sourceFiles) {
  const content = await readFile(file, 'utf8');
  for (const pattern of forbidden) {
    if (pattern.test(content)) {
      failed = true;
      console.error(`${file}: forbidden unfinished marker ${pattern}`);
    }
  }
}
if (failed) process.exit(1);
console.log(`syntax-check ok: ${sourceFiles.length} JavaScript modules`);
