import { ESLint } from 'eslint';

const eslint = new ESLint({ errorOnUnmatchedPattern: true });
const results = await eslint.lintFiles(['src/**/*.js', 'scripts/**/*.mjs', 'test/**/*.mjs', 'eslint.config.js']);
const errors = results.reduce((sum, result) => sum + result.errorCount, 0);
const warnings = results.reduce((sum, result) => sum + result.warningCount, 0);
if (errors || warnings) {
  const formatter = await eslint.loadFormatter('stylish');
  process.stdout.write(await formatter.format(results));
  process.exit(1);
}
console.log(`eslint ok: ${results.length} files, 0 errors, 0 warnings`);
