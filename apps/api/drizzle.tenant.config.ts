import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/tenant/schema.ts',
  out: './migrations/tenant',
});
