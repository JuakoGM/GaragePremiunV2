import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(?:js|mjs)$/.test(file) && !file.endsWith('assets/supabase.js')) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  }
}
execFileSync(process.execPath, ['--check', 'server.js'], { stdio: 'inherit' });
for (const dir of ['src', 'public', 'scripts', 'tests']) walk(dir);
console.log('Sintaxis verificada.');
