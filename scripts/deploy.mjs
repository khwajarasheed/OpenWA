import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const deployArgs = process.argv.slice(2);
const sourceConfigPath = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url));
const resolvedConfigPath = fileURLToPath(new URL('../wrangler.generated.jsonc', import.meta.url));

const runWrangler = async (args) => new Promise((resolve, reject) => {
  const child = spawn('npx', ['--no-install', 'wrangler', ...args], { cwd: root, stdio: 'inherit' });
  child.on('error', reject);
  child.on('close', (status) => status === 0 ? resolve() : reject(new Error(`Wrangler ${args.join(' ')} failed`)));
});

const captureWrangler = async (args) => new Promise((resolve, reject) => {
  const child = spawn('npx', ['--no-install', 'wrangler', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.on('error', reject);
  child.on('close', (status) => status === 0 ? resolve(output) : reject(new Error(output || `Wrangler ${args.join(' ')} failed`)));
});

const isAlreadyPresent = (error) => /already exists|already in use|already taken|duplicate/i.test(String(error.message ?? error));
const isPlaceholder = (database) => !database?.database_id || database.database_id.startsWith('REPLACE_WITH_');

async function resolveRemoteBindings() {
  const config = JSON.parse(await readFile(sourceConfigPath, 'utf8'));
  const databaseIndex = config.d1_databases?.findIndex((item) => item.binding === 'DB') ?? -1;
  const database = databaseIndex >= 0 ? config.d1_databases[databaseIndex] : null;
  if (!database) throw new Error('wrangler.jsonc must declare the DB D1 binding');

  if (isPlaceholder(database)) {
    const databases = JSON.parse(await captureWrangler(['d1', 'list', '--json']));
    const existing = databases.find((item) => item.name === database.database_name);
    if (existing) {
      database.database_id = existing.uuid;
    } else {
      config.d1_databases.splice(databaseIndex, 1);
      await writeFile(resolvedConfigPath, `${JSON.stringify(config, null, 2)}\n`);
      await runWrangler(['d1', 'create', database.database_name, '--binding', 'DB', '--update-config', '--use-remote', '--config', resolvedConfigPath]);
      return;
    }
  }

  await writeFile(resolvedConfigPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function ensureResource(kind, name, args) {
  try { await captureWrangler(args); }
  catch (error) {
    if (!isAlreadyPresent(error)) throw error;
    console.log(`${kind} ${name} already exists; reusing it.`);
  }
}

async function provisionForDeployment() {
  await resolveRemoteBindings();
  const config = JSON.parse(await readFile(resolvedConfigPath, 'utf8'));
  const media = config.r2_buckets?.find((item) => item.binding === 'MEDIA');
  if (!media?.bucket_name) throw new Error('wrangler.jsonc must declare the MEDIA R2 binding');
  await ensureResource('R2 bucket', media.bucket_name, ['r2', 'bucket', 'create', media.bucket_name]);
  const queues = [
    ...(config.queues?.producers ?? []).map((item) => item.queue),
    ...(config.queues?.consumers ?? []).map((item) => item.queue),
  ];
  for (const queue of [...new Set(queues)]) await ensureResource('Queue', queue, ['queues', 'create', queue]);
}

// A dry run must stay read-only. Real Deploy Button and operator deployments
// migrate the D1 binding before publishing code that expects the new schema.
const isDryRun = deployArgs.includes('--dry-run');
if (!isDryRun) {
  await provisionForDeployment();
  await runWrangler(['d1', 'migrations', 'apply', 'DB', '--remote', '--config', resolvedConfigPath]);
}
await runWrangler(['deploy', '--config', isDryRun ? sourceConfigPath : resolvedConfigPath, ...deployArgs]);
