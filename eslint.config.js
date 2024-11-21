import tseslint from 'typescript-eslint';
import ddgConfig from '@duckduckgo/eslint-config';
import globals from 'globals';

// @ts-check
export default tseslint.config(
    {
        ignores: [
            'web-platform-tests',
            'build/**/*',
        ],
    },
    ...ddgConfig,
    ...tseslint.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'script',
        },

        rules: {
            'require-await': ['error'],
            'promise/prefer-await-to-then': ['error'],
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    args: 'none',
                    caughtErrors: 'none',
                    ignoreRestSiblings: true,
                    vars: 'all',
                },
            ],
        },
    },
    {
        files: ['scripts/**/*.mjs'],
        languageOptions: {
            globals: {
                ...globals.node,
            },
        },
    },
);
