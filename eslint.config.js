import globals from 'globals';

const rules = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
  'no-unreachable': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'valid-typeof': 'error',
  'no-fallthrough': 'error',
  eqeqeq: ['error', 'always'],
  'prefer-const': 'error',
  'no-self-assign': 'error',
  'no-useless-catch': 'error',
};

export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  { files: ['src/**/*.js'], languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.browser, ...globals.es2022 } }, rules },
  { files: ['scripts/**/*.mjs', 'eslint.config.js'], languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node, ...globals.es2022 } }, rules },
  { files: ['test/**/*.mjs'], languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node, ...globals.es2022 } }, rules },
];
