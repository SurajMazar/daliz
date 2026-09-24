import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC is required so Nest's decorator metadata is emitted in tests.
export default defineConfig({
  plugins: [
    swc.vite({
      // Ignore .swcrc (it's the production-image transpile config, which excludes tests).
      swcrc: false,
      module: { type: 'es6' },
      jsc: {
        target: 'es2023',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true, useDefineForClassFields: false },
      },
    }),
  ],
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Integration tests share real Postgres/Redis; run files serially.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    setupFiles: ['src/test/setup-env.ts'],
  },
});
