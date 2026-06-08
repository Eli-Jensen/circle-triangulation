import globals from 'globals';

export default [
  {
    files: ['**/*.js'],
    ignores: ['node_modules/**', 'backend/**', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        // Libraries loaded via CDN
        L: 'readonly',          // Leaflet
        turf: 'readonly',       // Turf.js
        firebase: 'readonly',   // Firebase compat SDK
        // Our globals
        APP_CONFIG: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-redeclare': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      'no-constant-condition': 'warn',
      'no-empty': 'warn',
      'valid-typeof': 'error',
      'eqeqeq': ['warn', 'smart'],
    },
  },
];
