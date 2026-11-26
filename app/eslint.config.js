import globals from 'globals'
import pluginVue from 'eslint-plugin-vue'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'dist-refresh/**', 'node_modules/**', '.tmp-*/**'] },
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: { parserOptions: { parser: tseslint.parser }, globals: globals.browser },
  },
  { files: ['src/**/*.ts'], languageOptions: { globals: globals.browser } },
  { files: ['tests/chrome/*.js'], languageOptions: { globals: globals.browser } },
  { files: ['electron/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.{ts,mjs}', '*.config.{ts,js}'], languageOptions: { globals: globals.node } },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'vue/multi-word-component-names': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
      'vue/html-indent': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'vue/first-attribute-linebreak': 'off',
      'vue/multiline-html-element-content-newline': 'off',
    },
  },
)
