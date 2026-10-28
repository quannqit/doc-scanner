import { configDefaults, defineConfig } from 'vitest/config';

// test/private holds local-only fixtures and evals (gitignored, needs data under /tmp).
// Run them with DOC_SCANNER_PRIVATE=1 npx vitest run test/private
export default defineConfig({
  test: {
    exclude: process.env.DOC_SCANNER_PRIVATE ? configDefaults.exclude : [...configDefaults.exclude, 'test/private/**'],
  },
});
