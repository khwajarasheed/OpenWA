import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const deployArgs = process.argv.slice(2);

const runWrangler = async (args) => new Promise((resolve, reject) => {
  const child = spawn('npx', ['--no-install', 'wrangler', ...args], { cwd: root, stdio: 'inherit' });
  child.on('error', reject);
  child.on('close', (status) => status === 0 ? resolve() : reject(new Error(`Wrangler ${args.join(' ')} failed`)));
});

// A dry run must stay read-only. Real Deploy Button and operator deployments
// migrate the D1 binding before publishing code that expects the new schema.
if (!deployArgs.includes('--dry-run')) await runWrangler(['d1', 'migrations', 'apply', 'DB', '--remote']);
await runWrangler(['deploy', ...deployArgs]);
