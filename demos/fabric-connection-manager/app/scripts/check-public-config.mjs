import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { appRoot, loadDeploymentConfig } from './deployment-config.mjs';

try {
  const config = await loadDeploymentConfig();
  const values = Object.values(config).map(value => value.toLowerCase());
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'],
    { cwd: appRoot, encoding: 'utf8' }).trim();
  const project = path.relative(repoRoot, path.dirname(appRoot)).split(path.sep).join('/');
  const files = new Set(execFileSync('git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', project],
    { cwd: repoRoot, encoding: 'utf8' }).split('\0').filter(Boolean));
  const hits = [];
  let checked = 0;
  for (const file of files) {
    let text;
    try {
      text = await readFile(path.join(repoRoot, file), 'utf8');
    } catch (error) {
      // A tracked file deleted in the working tree is not publishable content.
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    checked++;
    const localState = /(?:^|\/)\.env(?:$|\.)/.test(file) && !file.endsWith('/.env.example')
      || /\/rayfin\/(?:rayfin\.yml|\.(?:project|deployments)\.json)$/.test(file)
      || file.endsWith('/resources.generated.ts');
    if (localState || values.some(value => text.toLowerCase().includes(value))) hits.push(file);
  }
  if (hits.length) {
    console.error('Local deployment values or state found in Git-eligible files (values omitted):');
    for (const file of hits) console.error(file);
    process.exitCode = 1;
  } else {
    console.log(`No local deployment values in ${checked} Git-eligible project files.`);
  }

  // Workspace IDs are intentionally projected by the SDK for browser API calls.
  const resourceIds = [config.lakehouseId, config.sqlDatabaseId];
  async function scanFrontend(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await scanFrontend(file);
      } else {
        const text = await readFile(file, 'utf8');
        if (resourceIds.some(value => text.toLowerCase().includes(value))) {
          throw new Error('Server-only storage identifiers found in frontend build output (values omitted).');
        }
      }
    }
  }
  await scanFrontend(path.join(appRoot, 'packages', 'frontend', 'dist'));
  console.log('Frontend build contains no configured server-only storage identifiers.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
