import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
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

const putSecret = async (name, value) => {
  const status = await new Promise((resolve) => {
    const child = spawn('npx', ['--no-install', 'wrangler', 'secret', 'put', name], { cwd: root, stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', () => resolve(1));
    child.on('close', resolve);
    child.stdin.end(`${value}\n`);
  });
  if (status !== 0) throw new Error(`Unable to set ${name}`);
};

const promptForWranglerSecret = async (name) => {
  const status = await new Promise((resolve) => {
    const child = spawn('npx', ['--no-install', 'wrangler', 'secret', 'put', name], { cwd: root, stdio: 'inherit' });
    child.on('error', () => resolve(1));
    child.on('close', resolve);
  });
  if (status !== 0) throw new Error(`Unable to set ${name}`);
};

const prompt = async (question) => {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await terminal.question(question)).trim();
    if (!answer) throw new Error('A value is required.');
    return answer;
  } finally {
    terminal.close();
  }
};

const readConfig = async () => JSON.parse(await readFile(configPath, 'utf8'));
const writeConfig = async (config) => writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

const resourceNames = (prefix) => ({
  worker: `${prefix}-core`,
  database: `${prefix}-core`,
  bucket: `${prefix}-media`,
  inbound: `${prefix}-inbound`,
  outbound: `${prefix}-outbound`,
  maintenance: `${prefix}-maintenance`,
  dlq: `${prefix}-dlq`,
});

const hasBinding = (config, property, binding) => (config[property] ?? []).some((entry) => entry.binding === binding);
const isPlaceholder = (config, property, binding, field) => {
  const entry = (config[property] ?? []).find((candidate) => candidate.binding === binding);
  return Boolean(entry?.[field]?.startsWith?.('REPLACE_WITH_')) || entry?.[field] === 'openwa-media-pending';
};

async function main() {
  if (hasFlag('--help')) {
    console.log(`Usage: npm run setup -- [options]

Options:
  --prefix <name>             Cloudflare resource prefix (default: openwa)
  --waba-id <id>              WhatsApp Business Account ID; prompted when omitted
  --phone-number-ids <ids>    Comma-separated Meta phone-number IDs; prompted when omitted
  --location <hint>           D1/R2 location hint, such as apac or weur
  --jurisdiction <value>      D1 jurisdiction: eu, us, or fedramp
  --skip-secrets              Do not upload Meta/bootstrap secrets
  --no-deploy                 Provision resources/configure secrets but do not migrate/deploy
`);
    return;
  }

  const prefix = option('--prefix') ?? 'openwa';
  if (!/^[a-z0-9-]{3,48}$/.test(prefix)) throw new Error('--prefix must be 3-48 lowercase letters, digits, or hyphens.');
  const names = resourceNames(prefix);
  const wabaId = option('--waba-id') ?? await prompt('Meta WABA ID: ');
  const phoneNumberIds = option('--phone-number-ids') ?? await prompt('Meta phone-number ID(s), comma-separated: ');
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
  config.vars = { ...config.vars, WABA_ID: wabaId, PHONE_NUMBER_IDS: phoneNumberIds };
  config.queues = {
    ...config.queues,
    producers: [
      { binding: 'INBOUND_QUEUE', queue: names.inbound },
      { binding: 'OUTBOUND_QUEUE', queue: names.outbound },
      { binding: 'MAINTENANCE_QUEUE', queue: names.maintenance },
    ],
    consumers: [
      { queue: names.inbound, max_batch_size: 10, max_retries: 10, dead_letter_queue: names.dlq },
      { queue: names.outbound, max_batch_size: 10, max_retries: 10, dead_letter_queue: names.dlq },
      { queue: names.maintenance, max_batch_size: 5, max_retries: 5, dead_letter_queue: names.dlq },
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
  for (const queueName of [names.inbound, names.outbound, names.maintenance, names.dlq]) {
    await run(['queues', 'create', queueName], { allowExists: true });
  }

  if (!hasFlag('--skip-secrets')) {
    const webhookToken = randomBytes(32).toString('base64url');
    const bootstrapToken = randomBytes(32).toString('base64url');
    console.log('\nUploading secrets directly to your Cloudflare account…');
    if (process.env.META_ACCESS_TOKEN) await putSecret('META_ACCESS_TOKEN', process.env.META_ACCESS_TOKEN);
    else await promptForWranglerSecret('META_ACCESS_TOKEN');
    if (process.env.META_APP_SECRET) await putSecret('META_APP_SECRET', process.env.META_APP_SECRET);
    else await promptForWranglerSecret('META_APP_SECRET');
    await putSecret('WEBHOOK_VERIFY_TOKEN', webhookToken);
    await putSecret('BOOTSTRAP_ADMIN_TOKEN', bootstrapToken);
    console.log('\nSave these generated values now; they are not written to disk:');
    console.log(`WEBHOOK_VERIFY_TOKEN=${webhookToken}`);
    console.log(`BOOTSTRAP_ADMIN_TOKEN=${bootstrapToken}`);
  }

  if (hasFlag('--no-deploy')) {
    console.log('\nResources provisioned. Run npm run deploy when ready.');
    return;
  }

  console.log('\nApplying D1 migrations…');
  await run(['d1', 'migrations', 'apply', names.database, '--remote']);
  console.log('\nDeploying OpenWA CORE…');
  await run(['deploy']);
  console.log('\nDeployment complete. Register the printed Worker URL plus /webhooks/meta in Meta, using WEBHOOK_VERIFY_TOKEN shown above.');
}

main().catch((error) => {
  console.error(`\nSetup stopped: ${error.message ?? error}`);
  process.exitCode = 1;
});
