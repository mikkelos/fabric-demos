import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { appRoot, loadDeploymentConfig, prepareDeployment } from './deployment-config.mjs';

try {
  await prepareDeployment();
  const { workspaceId } = await loadDeploymentConfig();
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve('@microsoft/rayfin-cli/package.json');
  const manifest = require(manifestPath);
  const { resolve, dirname } = await import('node:path');
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.rayfin;
  const args = process.argv.slice(2);
  if (args.some(arg => /^(-w(?:.*)|--workspace(?:-id|-uri)?(?:=.*)?|--env-file(?:=.*)?|--item-name(?:=.*)?)$/.test(arg))) {
    throw new Error('Configure the target using rayfin/.env or RAYFIN_ENV_FILE, not CLI target overrides.');
  }
  const child = spawn(process.execPath, [resolve(dirname(manifestPath), bin), 'up',
    '--workspace-id', workspaceId, '--item-name', 'fabric-connection-manager', ...args],
  { cwd: appRoot, env: process.env, stdio: 'inherit' });
  child.on('error', () => {
    console.error('Could not start the installed Rayfin deployment CLI.');
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
