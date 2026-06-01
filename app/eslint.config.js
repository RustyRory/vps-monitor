import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    files: ['api/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },
  {
    files: ['api/**/*.test.js'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        jest: 'readonly',
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
      },
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      globals: {
        fetch: 'readonly',
        document: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        window: 'readonly',
        location: 'readonly',
        navigator: 'readonly',
        WebSocket: 'readonly',
        confirm: 'readonly',
        alert: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { varsIgnorePattern: '^(containerAction|logout|showLogs|closeLogs|showTab|saveAppsJson|nginxAddApp|nginxRemoveApp|updateDeployApp|promptClone|cloneNewApp|removeContainer|deleteDeployApp)$' }],
    },
  },
];
