import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const configPath = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url));
const apiBase = 'https://api.cloudflare.com/client/v4';

const usage = `Usage: npm run cleanup -- [options]

Preview only (the default):
  npm run cleanup

Permanently delete the listed installation:
  npm run cleanup -- --yes

Options:
  --yes                       Perform the irreversible deletion
  --account-id <32-hex-id>    Select an account when Wrangler has more than one
  --jurisdiction <value>      R2 jurisdiction: default, eu, us, or fedramp
  --delete-github-repo <owner/repository>
                              Also permanently delete this exact GitHub.com repository
  --help                      Show this help
`;

export function parseArguments(args) {
  const result = {
    yes: false,
    help: false,
    accountId: undefined,
    jurisdiction: undefined,
    githubRepository: undefined,
  };
  const valueOptions = new Map([
    ['--account-id', 'accountId'],
    ['--jurisdiction', 'jurisdiction'],
    ['--delete-github-repo', 'githubRepository'],
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--yes') result.yes = true;
    else if (argument === '--help' || argument === '-h') result.help = true;
    else if (valueOptions.has(argument)) {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
      result[valueOptions.get(argument)] = value;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  if (result.accountId && !/^[a-f0-9]{32}$/i.test(result.accountId)) {
    throw new Error('--account-id must be a 32-character hexadecimal Cloudflare account ID.');
  }
  if (result.jurisdiction && !['default', 'eu', 'us', 'fedramp'].includes(result.jurisdiction)) {
    throw new Error('--jurisdiction must be default, eu, us, or fedramp.');
  }
  if (result.githubRepository && !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(result.githubRepository)) {
    throw new Error('--delete-github-repo must be an exact GitHub owner/repository name.');
  }
  return result;
}

function binding(entries, bindingName) {
  return (entries ?? []).find((entry) => entry.binding === bindingName);
}

function validName(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || /[\0\r\n]/.test(value)) {
    throw new Error(`The ${label} in wrangler.jsonc is not a safe Cloudflare resource name.`);
  }
  return value;
}

export function targetsFromConfig(config) {
  const worker = validName(config.name, 'Worker name');
  if (!worker) throw new Error('wrangler.jsonc does not define a Worker name.');

  const database = validName(binding(config.d1_databases, 'DB')?.database_name, 'DB database name');
  const mediaBinding = binding(config.r2_buckets, 'MEDIA');
  const bucket = validName(mediaBinding?.bucket_name, 'MEDIA bucket name');
  const jobsProducer = binding(config.queues?.producers, 'JOBS_QUEUE');
  const dlqProducer = binding(config.queues?.producers, 'DEAD_LETTER_QUEUE');
  const jobsConsumer = (config.queues?.consumers ?? []).find((consumer) => consumer.queue === jobsProducer?.queue);
  const jobs = validName(jobsProducer?.queue, 'jobs queue name');
  const dlq = validName(dlqProducer?.queue ?? jobsConsumer?.dead_letter_queue, 'dead-letter queue name');
  const queues = [...new Set([jobs, dlq].filter(Boolean))];
  const durableObjectClasses = (config.durable_objects?.bindings ?? [])
    .map((entry) => validName(entry.class_name, 'Durable Object class name'))
    .filter(Boolean);

  return {
    worker,
    database,
    bucket,
    jobsQueue: jobs,
    queues,
    durableObjectClasses,
    jurisdiction: mediaBinding?.jurisdiction,
  };
}

export function encodeObjectKey(key) {
  return key.split('/').map((part) => encodeURIComponent(part)).join('/');
}

export function isTargetWorkerConsumer(consumer, worker) {
  return consumer?.type === 'worker'
    && (consumer.script_name === worker || consumer.script === worker || consumer.service === worker);
}

function commandOutput(error) {
  return `${error.stdout ?? ''}\n${error.stderr ?? ''}\n${error.message ?? ''}`.trim();
}

function missingResource(output) {
  return /(?:not found|does not exist|could not find|couldn't find|no (?:such )?(?:worker|queue|database|bucket)|http status 404)/i.test(output);
}

function runWrangler(argumentsList, { accountId, quiet = false, allowMissing = false } = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const childEnvironment = { ...process.env, CI: '1' };
    if (accountId) childEnvironment.CLOUDFLARE_ACCOUNT_ID = accountId;
    execFile(
      'npx',
      ['--no-install', 'wrangler', ...argumentsList],
      { cwd: root, env: childEnvironment, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          if (!quiet && stdout) process.stdout.write(stdout);
          if (!quiet && stderr) process.stderr.write(stderr);
          resolveCommand(stdout);
          return;
        }

        const output = commandOutput(Object.assign(error, { stdout, stderr }));
        if (allowMissing && missingResource(output)) {
          console.log('  Already absent; nothing to delete.');
          resolveCommand('');
          return;
        }
        if (!quiet && output) process.stderr.write(`${output}\n`);
        rejectCommand(new Error(output || `Wrangler ${argumentsList.join(' ')} failed.`));
      },
    );
  });
}

function runGitHub(argumentsList, { quiet = false, allowMissing = false } = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(
      'gh',
      argumentsList,
      { cwd: root, env: process.env, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          if (!quiet && stdout) process.stdout.write(stdout);
          if (!quiet && stderr) process.stderr.write(stderr);
          resolveCommand(stdout);
          return;
        }
        const output = commandOutput(Object.assign(error, { stdout, stderr }));
        if (allowMissing && /(?:not found|http 404)/i.test(output)) {
          console.log('  GitHub repository is already absent; nothing to delete.');
          resolveCommand('');
          return;
        }
        if (!quiet && output) process.stderr.write(`${output}\n`);
        rejectCommand(new Error(output || `GitHub CLI ${argumentsList.join(' ')} failed.`));
      },
    );
  });
}

function parseJson(output, command) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`Could not parse JSON returned by ${command}.`);
  }
}

async function resolveAccount(requestedAccountId, config) {
  const whoami = parseJson(await runWrangler(['whoami', '--json'], { quiet: true }), 'wrangler whoami');
  const accounts = Array.isArray(whoami.accounts) ? whoami.accounts : [];
  const environmentAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const configuredAccountId = typeof config.account_id === 'string' ? config.account_id : undefined;
  if (requestedAccountId && configuredAccountId && requestedAccountId !== configuredAccountId) {
    throw new Error('--account-id does not match the account_id in wrangler.jsonc. Refusing to select between them.');
  }
  if (environmentAccountId && configuredAccountId && environmentAccountId !== configuredAccountId) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID does not match the account_id in wrangler.jsonc.');
  }
  const selected = requestedAccountId
    ?? environmentAccountId
    ?? configuredAccountId;

  if (selected) {
    if (!/^[a-f0-9]{32}$/i.test(selected)) throw new Error('The selected Cloudflare account ID is invalid.');
    if (accounts.length > 0 && !accounts.some((account) => account.id === selected)) {
      throw new Error(`Wrangler is not authenticated for Cloudflare account ${selected}.`);
    }
    return selected;
  }
  if (accounts.length === 1 && /^[a-f0-9]{32}$/i.test(accounts[0].id)) return accounts[0].id;
  if (accounts.length > 1) {
    throw new Error('Wrangler can access multiple Cloudflare accounts. Re-run with --account-id <ACCOUNT_ID>.');
  }
  throw new Error('Wrangler did not return an accessible Cloudflare account. Run wrangler login and try again.');
}

async function readCredentials(accountId) {
  const result = parseJson(
    await runWrangler(['auth', 'token', '--json'], { accountId, quiet: true }),
    'wrangler auth token',
  );
  if ((result.type === 'oauth' || result.type === 'api_token') && result.token) {
    return { Authorization: `Bearer ${result.token}` };
  }
  if (result.type === 'api_key' && result.key && result.email) {
    return { 'X-Auth-Key': result.key, 'X-Auth-Email': result.email };
  }
  throw new Error('Wrangler returned an unsupported Cloudflare credential type.');
}

class CloudflareApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function curlConfigValue(value) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function runCurl(path, { headers, jurisdiction, method }) {
  return new Promise((resolveCurl, rejectCurl) => {
    const requestHeaders = {
      ...headers,
      ...(jurisdiction ? { 'cf-r2-jurisdiction': jurisdiction } : {}),
    };
    const curl = spawn('curl', [
      '--silent',
      '--show-error',
      '--request', method,
      '--config', '-',
      '--write-out', '\n%{http_code}',
      `${apiBase}${path}`,
    ]);
    const stdout = [];
    const stderr = [];
    curl.stdout.on('data', (chunk) => stdout.push(chunk));
    curl.stderr.on('data', (chunk) => stderr.push(chunk));
    curl.on('error', (error) => rejectCurl(error));
    curl.on('close', (status) => {
      const output = Buffer.concat(stdout).toString();
      const splitAt = output.lastIndexOf('\n');
      const httpStatus = Number(output.slice(splitAt + 1));
      const body = splitAt >= 0 ? output.slice(0, splitAt) : '';
      if (status !== 0 || !Number.isInteger(httpStatus)) {
        const details = Buffer.concat(stderr).toString().trim();
        rejectCurl(new Error(details || 'curl could not reach the Cloudflare API.'));
        return;
      }
      resolveCurl({ body, status: httpStatus });
    });
    for (const [name, value] of Object.entries(requestHeaders)) {
      curl.stdin.write(`header = ${curlConfigValue(`${name}: ${value}`)}\n`);
    }
    curl.stdin.end();
  });
}

async function cloudflareRequest(path, { headers, jurisdiction, method = 'GET' }) {
  let response;
  try {
    response = await runCurl(path, { headers, jurisdiction, method });
  } catch (error) {
    throw new CloudflareApiError(`Could not reach the Cloudflare API: ${error.message}`, 0);
  }
  const body = JSON.parse(response.body || '{}');
  if (response.status < 200 || response.status >= 300 || body?.success === false) {
    const details = body?.errors?.map((error) => error.message).filter(Boolean).join('; ');
    throw new CloudflareApiError(details || `Cloudflare API returned HTTP ${response.status}.`, response.status);
  }
  return body;
}

async function listR2Objects(accountId, bucket, credentials, jurisdiction) {
  const path = `/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}/objects?per_page=1000`;
  const response = await cloudflareRequest(path, { headers: credentials, jurisdiction });
  return Array.isArray(response?.result) ? response.result : [];
}

async function deleteR2Object(accountId, bucket, key, credentials, jurisdiction) {
  const path = `/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}/objects/${encodeObjectKey(key)}`;
  try {
    await cloudflareRequest(path, { headers: credentials, jurisdiction, method: 'DELETE' });
  } catch (error) {
    if (!(error instanceof CloudflareApiError && error.status === 404)) throw error;
  }
}

async function inspectR2(accountId, bucket, credentials, jurisdiction) {
  try {
    await listR2Objects(accountId, bucket, credentials, jurisdiction);
    return true;
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) return false;
    throw new Error(`Cannot access R2 bucket '${bucket}': ${error.message}`);
  }
}

async function deleteWorker(accountId, worker, credentials) {
  const path = `/accounts/${accountId}/workers/services/${encodeURIComponent(worker)}?force=false`;
  try {
    await cloudflareRequest(path, { headers: credentials, method: 'DELETE' });
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) {
      console.log('  Already absent; nothing to delete.');
      return;
    }
    throw new Error(
      `Cloudflare refused to delete Worker '${worker}': ${error.message}. `
      + 'The cleanup command never force-deletes a Worker that may be used by another project.',
    );
  }
}

async function listAccountQueues(accountId, credentials) {
  const queues = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages) {
    const response = await cloudflareRequest(`/accounts/${accountId}/queues?page=${page}`, { headers: credentials });
    queues.push(...(Array.isArray(response?.result) ? response.result : []));
    totalPages = Number(response?.result_info?.total_pages) || 1;
    page += 1;
  }
  return queues;
}

async function removeProjectQueueConsumers(accountId, worker, credentials) {
  let queues;
  try {
    queues = await listAccountQueues(accountId, credentials);
  } catch (error) {
    throw new Error(`Cannot list Queues in this account: ${error.message}`);
  }

  const projectQueues = new Set();
  let removed = 0;
  for (const queue of queues) {
    const queueName = queue.queue_name;
    const queueId = queue.queue_id;
    if (!queueName || !queueId) continue;
    const consumers = Array.isArray(queue.consumers) ? queue.consumers : [];
    const projectConsumers = consumers.filter((consumer) => isTargetWorkerConsumer(consumer, worker));
    const producedByWorker = (queue.producers ?? []).some((producer) => producer?.type === 'worker' && producer.script === worker);
    if (projectConsumers.length === 0 && !producedByWorker) continue;

    projectQueues.add(queueName);
    for (const consumer of projectConsumers) {
      if (!consumer.consumer_id) throw new Error(`Cloudflare did not return an ID for a Worker consumer on Queue '${queueName}'.`);
      await cloudflareRequest(
        `/accounts/${accountId}/queues/${queueId}/consumers/${consumer.consumer_id}`,
        { headers: credentials, method: 'DELETE' },
      );
      removed += 1;
      if (consumer.dead_letter_queue) projectQueues.add(consumer.dead_letter_queue);
    }
  }
  if (removed === 0) console.log(`  No Queue consumers currently belong to Worker '${worker}'.`);
  else console.log(`  Removed ${removed} consumer${removed === 1 ? '' : 's'} for Worker '${worker}'.`);
  return [...projectQueues];
}

async function deleteD1Database(accountId, databaseName, credentials) {
  const response = await cloudflareRequest(
    `/accounts/${accountId}/d1/database?name=${encodeURIComponent(databaseName)}&per_page=10`,
    { headers: credentials },
  );
  const matches = (Array.isArray(response?.result) ? response.result : [])
    .filter((database) => database.name === databaseName);
  if (matches.length === 0) {
    console.log('  Already absent; nothing to delete.');
    return;
  }
  if (matches.length !== 1 || !/^[a-f0-9-]{36}$/i.test(matches[0].uuid ?? '')) {
    throw new Error(`Cloudflare returned an ambiguous or invalid D1 database ID for '${databaseName}'.`);
  }
  await cloudflareRequest(
    `/accounts/${accountId}/d1/database/${matches[0].uuid}`,
    { headers: credentials, method: 'DELETE' },
  );
  console.log(`  Deleted D1 database '${databaseName}'.`);
}

async function verifyGitHubRepositoryAccess(repository) {
  try {
    await runGitHub(['repo', 'view', repository, '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { quiet: true });
  } catch (error) {
    throw new Error(
      `Cannot access GitHub repository '${repository}'. Run 'gh auth login' and ensure you have admin access: ${error.message}`,
    );
  }
}

async function deleteGitHubRepository(repository) {
  await runGitHub(['repo', 'delete', repository, '--yes'], { allowMissing: true });
  console.log(`  Deleted GitHub repository '${repository}'.`);
}

async function emptyR2(accountId, bucket, credentials, jurisdiction) {
  let deleted = 0;
  while (true) {
    const objects = await listR2Objects(accountId, bucket, credentials, jurisdiction);
    if (objects.length === 0) break;
    const keys = objects.map((object) => object.key).filter((key) => typeof key === 'string');
    if (keys.length !== objects.length) throw new Error('Cloudflare returned an R2 object without a key.');

    for (let index = 0; index < keys.length; index += 20) {
      await Promise.all(
        keys.slice(index, index + 20).map((key) => deleteR2Object(accountId, bucket, key, credentials, jurisdiction)),
      );
    }
    deleted += keys.length;
    console.log(`  Deleted ${deleted} R2 object${deleted === 1 ? '' : 's'}…`);
  }
  return deleted;
}

function printTargets(targets, githubRepository) {
  console.log('\nOpenWA Cloudflare cleanup targets');
  console.log(`  Worker: ${targets.worker}`);
  console.log(`  Durable Objects: ${targets.durableObjectClasses.join(', ') || '(none configured)'} (owned by Worker)`);
  console.log(`  Queue consumer to remove: ${targets.jobsQueue ? `${targets.worker} <- ${targets.jobsQueue}` : '(none configured)'}`);
  console.log(`  Queues: ${targets.queues.join(', ') || '(none configured)'}`);
  console.log(`  R2 bucket: ${targets.bucket ?? '(none configured)'}`);
  console.log(`  D1 database: ${targets.database ?? '(none configured)'}`);
  console.log(`  GitHub repository: ${githubRepository ?? '(not requested)'}`);
  console.log('\nNot touched: local Git files, Cloudflare Pages landing site, domains, or unrelated account resources.');
}

async function attempt(label, action, failures) {
  console.log(`\n${label}`);
  try {
    await action();
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    console.error(`  Failed: ${error.message}`);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
    return;
  }

  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const targets = targetsFromConfig(config);
  const jurisdiction = options.jurisdiction ?? targets.jurisdiction;
  if (jurisdiction && !['default', 'eu', 'us', 'fedramp'].includes(jurisdiction)) {
    throw new Error(`Unsupported R2 jurisdiction '${jurisdiction}' in wrangler.jsonc.`);
  }
  printTargets(targets, options.githubRepository);

  if (!options.yes) {
    console.log('\nPreview only: no Cloudflare resources were changed.');
    console.log('Run npm run cleanup -- --yes to permanently delete exactly these resources.');
    return;
  }

  console.log('\nPreflight: checking Wrangler authentication and R2 access before deleting anything…');
  const accountId = await resolveAccount(options.accountId, config);
  const credentials = await readCredentials(accountId);
  const bucketExists = targets.bucket
    ? await inspectR2(accountId, targets.bucket, credentials, jurisdiction)
    : false;
  console.log(`  Cloudflare account: ${accountId}`);
  if (options.githubRepository) {
    console.log(`  Checking GitHub access to: ${options.githubRepository}`);
    await verifyGitHubRepositoryAccess(options.githubRepository);
  }
  console.log('  Preflight passed. Starting irreversible cleanup.');

  const failures = [];
  let discoveredQueues = [];
  await attempt(`Discovering and removing Queue consumers owned by Worker '${targets.worker}'…`, async () => {
    discoveredQueues = await removeProjectQueueConsumers(accountId, targets.worker, credentials);
    if (discoveredQueues.length > 0) console.log(`  Project Queue bindings found: ${discoveredQueues.join(', ')}`);
  }, failures);

  if (failures.length > 0) {
    throw new Error('The OpenWA Queue consumer could not be removed, so data resources were left intact.');
  }

  let workerDeleted = true;
  await attempt(`Deleting Worker '${targets.worker}' and its deployed bindings/Durable Objects…`, async () => {
    try {
      await deleteWorker(accountId, targets.worker, credentials);
    } catch (error) {
      workerDeleted = false;
      throw error;
    }
  }, failures);

  if (!workerDeleted) {
    throw new Error('Worker deletion failed, so data resources were left intact to avoid breaking a running Worker.');
  }

  const queueTargets = [...new Set([...targets.queues, ...discoveredQueues])];
  for (const queue of queueTargets) {
    await attempt(`Deleting Queue '${queue}'…`, () => (
      runWrangler(['queues', 'delete', queue], { accountId, allowMissing: true })
    ), failures);
  }

  if (targets.bucket) {
    await attempt(`Emptying and deleting R2 bucket '${targets.bucket}'…`, async () => {
      if (!bucketExists) {
        console.log('  Already absent; nothing to delete.');
        return;
      }
      const deleted = await emptyR2(accountId, targets.bucket, credentials, jurisdiction);
      if (deleted === 0) console.log('  Bucket is already empty.');
      const argumentsList = ['r2', 'bucket', 'delete', targets.bucket];
      if (jurisdiction) argumentsList.push('--jurisdiction', jurisdiction);
      await runWrangler(argumentsList, { accountId, allowMissing: true });
    }, failures);
  }

  if (targets.database) {
    await attempt(`Deleting D1 database '${targets.database}'…`, () => (
      deleteD1Database(accountId, targets.database, credentials)
    ), failures);
  }

  if (failures.length > 0) {
    console.error('\nCleanup completed with errors. Review the failures above; a second run is safe.');
    process.exitCode = 1;
    return;
  }

  if (options.githubRepository) {
    await attempt(`Deleting GitHub repository '${options.githubRepository}'…`, () => (
      deleteGitHubRepository(options.githubRepository)
    ), failures);
  }

  if (failures.length > 0) {
    console.error('\nCloudflare cleanup completed, but GitHub repository deletion failed.');
    process.exitCode = 1;
    return;
  }

  console.log('\nCleanup complete. Local project files and wrangler.jsonc bindings remain ready for the next deployment test.');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`\nCleanup stopped: ${error.message ?? error}`);
    process.exitCode = 1;
  });
}
