const eslint = require('@eslint/js');
const globals = require('globals');
const reactHooks = require('eslint-plugin-react-hooks');
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'frontend/android/**',
      'frontend/ios/**',
      'frontend/.expo/**',
      '**/*.old.tsx',
    ],
  },
  {
    files: ['frontend/**/*.{ts,tsx}', 'backend/**/*.ts'],
    extends: [eslint.configs.recommended, ...tseslint.configs.recommended],
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.jest,
        __DEV__: 'readonly',
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      // Keep the first lint rollout focused on correctness. Existing cleanup can
      // tighten style and unused-code rules incrementally without blocking CI.
      'no-undef': 'off',
      'no-empty': 'off',
      'no-useless-catch': 'off',
      'no-useless-escape': 'off',
      'no-unused-vars': 'off',
      'prefer-const': 'off',
      'react-hooks/rules-of-hooks': 'error',
      // The existing dependency-array backlog is intentionally non-blocking.
      // Enable this incrementally once those warnings have been baselined.
      'react-hooks/exhaustive-deps': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      // Мёртвый код виден сразу и ничего не ломает при удалении — держим как warn,
      // чтобы не блокировать CI на существующем хвосте.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          args: 'none',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
);
