import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderOpenApiDocument } from '../src/api/index.ts';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(scriptDirectory, '..', 'openapi.json');

await writeFile(outputPath, renderOpenApiDocument(), 'utf-8');

console.log(`OpenAPI spec written to ${outputPath}`);
