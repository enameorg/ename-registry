import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Create a pair of empty <unix_ts>_<name>.up.sql / .down.sql files in
// database/migrations/. The Unix-timestamp prefix gives a stable lexicographic order
// across machines without collisions in normal use.

const rawName = process.argv[2];
if (!rawName) {
  console.error('Usage: npm run db:new -- <name>');
  console.error('Example: npm run db:new -- create_persons_table');
  process.exit(1);
}

const slug = rawName
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '');

if (!slug) {
  console.error(`Invalid migration name: ${rawName}`);
  process.exit(1);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(scriptDir, '..', '..', 'database', 'migrations');
const timestamp = Math.floor(Date.now() / 1000).toString();
const base = `${timestamp}_${slug}`;
const upPath = resolve(migrationsDir, `${base}.up.sql`);
const downPath = resolve(migrationsDir, `${base}.down.sql`);

await mkdir(migrationsDir, { recursive: true });
await writeFile(upPath, `-- ${base} (up)\n\n`, { flag: 'wx' });
await writeFile(downPath, `-- ${base} (down)\n\n`, { flag: 'wx' });

console.log(`Created:\n  ${upPath}\n  ${downPath}`);
