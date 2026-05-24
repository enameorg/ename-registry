import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openApiMetadata } from '../src/api/openapi-metadata.ts';
import { app } from '../src/index.ts';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(scriptDir, '..', 'openapi.json');

const spec = app.getOpenAPI31Document(openApiMetadata);

await writeFile(outputPath, JSON.stringify(spec, null, 2) + '\n', 'utf-8');

console.log(`OpenAPI spec written to ${outputPath}`);
