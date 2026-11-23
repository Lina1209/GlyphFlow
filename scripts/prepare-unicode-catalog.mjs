#!/usr/bin/env node
// Ensure the pinned official UCD and its compact browser projection exist before Vite builds.
import { access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const version = '18.0.0';
const fullPath = `data/unicode/${version}/unicode-catalog.json`;
const runtimePath = `public/data/unicode/${version}/runtime-catalog.json`;

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

if (!(await exists(fullPath)) || !(await exists(runtimePath))) {
  const imported = spawnSync(process.execPath, ['scripts/update-unicode-catalog.mjs', version], {stdio:'inherit'});
  if (imported.status !== 0) process.exit(imported.status || 1);
}
const validated = spawnSync(process.execPath, ['scripts/validate-unicode-catalog.mjs', version], {stdio:'inherit'});
if (validated.status !== 0) process.exit(validated.status || 1);
console.log(`Unicode ${version} runtime catalog is ready for the production build.`);
