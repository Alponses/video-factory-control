import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const ignored = new Set(['.git', 'node_modules']);
let count = 0;

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;
    if (entry.name === '.secrets.json') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (entry.isFile() && entry.name.endsWith('.json')) {
      JSON.parse(await fs.readFile(full, 'utf8'));
      count += 1;
    }
  }
}

await walk(root);
console.log(`JSON válidos: ${count}`);
