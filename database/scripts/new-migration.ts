import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Create an empty <unix_ts>_<name>.sql file in database/migrations/. The
// Unix-timestamp prefix gives a stable lexicographic order across machines without
// collisions in normal use.

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

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = resolve(scriptDirectory, '..', 'migrations');
const timestamp = Math.floor(Date.now() / 1000).toString();
const base = `${timestamp}_${slug}`;
const path = resolve(migrationsDirectory, `${base}.sql`);

await mkdir(migrationsDirectory, { recursive: true });
await writeFile(path, `-- ${base}\n\n`, { flag: 'wx' });

console.log(`Created: ${path}`);
