import { defineConfig } from 'drizzle-kit';

// Schema lives in packages/db (shared with sandboxd); only the api generates and applies
// migrations. `pnpm --filter @rootcamp/api drizzle-kit generate` writes them to ./drizzle,
// which `runMigrations(db, dir)` reads at startup. Migrations are extend-only.
export default defineConfig({
  dialect: 'postgresql',
  schema: '../../packages/db/src/schema/index.ts',
  out: './drizzle',
});
