import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tests/unit/**/*.test.ts',
      'tests/properties/**/*.property.test.ts',
      'tests/integration/**/*.test.ts',
      'tests/demo/**/*.test.ts',
    ],
    globals: false,
    testTimeout: 30000,
  },
});
