import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const configPath = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url));
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const hasFlag = (name) => args.includes(name);

const run = async (argumentsList, { allowExists = false } = {}) => {
  try {
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      execFile('npx', ['--no-install', 'wrangler', ...argumentsList], { cwd: root }, (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve({ stdout, stderr });
      });
    });
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    return stdout;
  } catch (error) {
    const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}\n${error.message ?? ''}`;
    if (allowExists && /already exists|already in use|duplicate/i.test(output)) {
      console.log(`Resource already exists; continuing.`);
      return '';
    }
    process.stderr.write(output);
    throw error;
  }
};

const readConfig = async () => JSON.parse(await readFile(configPath, 'utf8'));
const writeConfig = async (config) => writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

const resourceNames = (prefix) => ({
  worker: `${prefix}-core`,
  database: `${prefix}-core`,
  bucket: `${prefix}-media`,
  jobs: `${prefix}-jobs`,
  dlq: `${prefix}-dlq`,
});

const hasBinding = (config, property, binding) => (config[property] ?? []).some((entry) => entry.binding === binding);
const isPlaceholder = (config, property, binding, field) => {
  const entry = (config[property] ?? []).find((candidate) => candidate.binding === binding);
  return Boolean(entry?.[field]?.startsWith?.('REPLACE_WITH_')) || entry?.[field] === 'openwa-media';
};

async function main() {
  if (hasFlag('--help')) {
    console.log(`Usage: npm run setup -- [options]

Options:
  --prefix <name>             Cloudflare resource prefix (default: openwa)
  --location <hint>           D1/R2 location hint, such as apac or weur
  --jurisdiction <value>      D1 jurisdiction: eu, us, or fedramp
  --no-deploy                 Provision resources but do not migrate or deploy
`);
    return;
  }

  const prefix = option('--prefix') ?? 'openwa';
  if (!/^[a-z0-9-]{3,48}$/.test(prefix)) throw new Error('--prefix must be 3-48 lowercase letters, digits, or hyphens.');
  const names = resourceNames(prefix);
  const location = option('--location');
  const jurisdiction = option('--jurisdiction');
  if (jurisdiction && !['eu', 'us', 'fedramp'].includes(jurisdiction)) throw new Error('--jurisdiction must be eu, us, or fedramp.');

  console.log('\nChecking Cloudflare authentication…');
  try {
    await run(['whoami']);
  } catch {
    console.log('Opening Cloudflare login…');
    await run(['login']);
  }

  let config = await readConfig();
  config.name = names.worker;
  delete config.vars;
  config.queues = {
    ...config.queues,
    producers: [
      { binding: 'JOBS_QUEUE', queue: names.jobs },
      { binding: 'DEAD_LETTER_QUEUE', queue: names.dlq },
    ],
    consumers: [
      { queue: names.jobs, max_batch_size: 10, max_retries: 10, dead_letter_queue: names.dlq },
    ],
  };
  await writeConfig(config);

  if (!hasBinding(config, 'd1_databases', 'DB') || isPlaceholder(config, 'd1_databases', 'DB', 'database_id')) {
    // Wrangler owns insertion of the real account-specific ID. Remove only the
    // committed placeholder before invoking its --update-config mechanism.
    config.d1_databases = (config.d1_databases ?? []).filter((entry) => entry.binding !== 'DB');
    await writeConfig(config);
    const d1Args = ['d1', 'create', names.database, '--binding', 'DB', '--update-config', '--use-remote'];
    if (jurisdiction) d1Args.push('--jurisdiction', jurisdiction);
    else if (location) d1Args.push('--location', location);
    await run(d1Args);
  }

  config = await readConfig();
  const d1Binding = config.d1_databases?.find((entry) => entry.binding === 'DB');
  if (d1Binding) {
    d1Binding.migrations_dir = 'migrations';
    await writeConfig(config);
  }

  config = await readConfig();
  if (!hasBinding(config, 'r2_buckets', 'MEDIA') || isPlaceholder(config, 'r2_buckets', 'MEDIA', 'bucket_name')) {
    config.r2_buckets = (config.r2_buckets ?? []).filter((entry) => entry.binding !== 'MEDIA');
    await writeConfig(config);
    const r2Args = ['r2', 'bucket', 'create', names.bucket, '--binding', 'MEDIA', '--update-config', '--use-remote'];
    if (jurisdiction) r2Args.push('--jurisdiction', jurisdiction);
    else if (location) r2Args.push('--location', location);
    await run(r2Args);
  }

  console.log('\nCreating Queues…');
  for (const queueName of [names.jobs, names.dlq]) {
    await run(['queues', 'create', queueName], { allowExists: true });
  }

  if (hasFlag('--no-deploy')) {
    console.log('\nResources provisioned. Run npm run deploy when ready.');
    return;
  }

  console.log('\nApplying D1 migrations…');
  await run(['d1', 'migrations', 'apply', names.database, '--remote']);
  console.log('\nDeploying ForgeScale Relay Core…');
  await run(['deploy']);
  console.log('\nDeployment complete. Open the printed Worker URL to create the owner and connect WhatsApp.');
}

main().catch((error) => {
  console.error(`\nSetup stopped: ${error.message ?? error}`);
  process.exitCode = 1;
});
