import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Compiled to dist/database/paths.js; migrations live at <app>/migrations.
const root = fileURLToPath(new URL('../../', import.meta.url));

export const MIGRATIONS = {
  platform: `${root}migrations/platform`,
  tenant: `${root}migrations/tenant`,
};

/** Latest migration tag in a folder, used as the schema version. */
export function latestMigrationTag(folder: string): string {
  const journal = JSON.parse(readFileSync(`${folder}/meta/_journal.json`, 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  const last = journal.entries.at(-1);
  if (!last) throw new Error(`No migrations in ${folder}`);
  return last.tag;
}
