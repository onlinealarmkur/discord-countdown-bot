import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(import.meta.dirname, '..');
const remoteUpdate = 'sudo bash /home/deploy/countdown-bot/deploy/digitalocean-setup.sh update';

export function validateHost(value) {
  if (typeof value !== 'string' || isIP(value) !== 4) {
    throw new Error('Deployment host must be a plain IPv4 address, not a URL or shell command.');
  }
  return value;
}

export function parseOptions(args) {
  return parseArgs({ args, options: {
    host: { type: 'string' },
    'dry-run': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  } }).values;
}

export async function deploymentHost(options, projectRoot = root) {
  if (options.host !== undefined) return validateHost(options.host);
  let config;
  try { config = JSON.parse(await readFile(join(projectRoot, 'deploy.config.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('Missing local deploy.config.json. Set {"serverIp":"YOUR_SERVER_IPV4"}, or use npm run deploy -- --host YOUR_SERVER_IPV4.');
    throw new Error('Cannot read deploy.config.json; it must contain valid JSON with a serverIp field.');
  }
  return validateHost(config?.serverIp);
}

export function runCommand(command, args, { cwd = root } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} failed (${signal ?? code}). Deployment stopped.`));
    });
  });
}

export async function deploy(host, options = {}, {
  projectRoot = root, identity = join(homedir(), '.ssh/digitalocean'), run = runCommand, log = console.log,
} = {}) {
  host = validateHost(host);
  if (options['dry-run']) {
    log(`Discord deploy → deploy@${host}`);
    log('Would verify dependencies/tests/build/audit, upload the verified source, ask for sudo in your terminal, update Discord, check READY and backups, and remove inactive releases and the upload folder.');
    log('One active runtime; no rollback copies. No commands, file writes or network requests were made.');
    return;
  }
  // Operational scripts are intentionally private/local in this repository.
  // Check them before starting a build or contacting the server.
  for (const name of ['digitalocean-upload.sh', 'digitalocean-setup.sh', 'cleanup.mjs']) {
    try { await access(join(projectRoot, 'deploy', name)); }
    catch { throw new Error(`Missing local deployment file: deploy/${name}. Run deployment from the operator checkout, not a source-only clone.`); }
  }
  try { await access(identity); }
  catch { throw new Error('The documented ~/.ssh/digitalocean key is missing. Configure your SSH access before deploying.'); }

  log(`Discord deploy → deploy@${host}`);
  // This script performs npm ci, verification, tooling tests, audit and rsync.
  // It and the server installer share a lock. Failure stops this sequence.
  await run('bash', [join(projectRoot, 'deploy/digitalocean-upload.sh'), host], { cwd: projectRoot });
  log('Upload verified. Updating the server; enter your sudo password in the terminal if asked.');
  await run('ssh', [
    '-t', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-i', identity, `deploy@${host}`, remoteUpdate,
  ], { cwd: projectRoot });
  log('Discord deployment passed: connected and checked; one active release, no inactive releases or source upload.');
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log('npm run deploy [-- --host IPV4] [-- --dry-run]\nThe host defaults to local, Git-ignored deploy.config.json. Upload and server update run together. SSH/sudo prompts stay in your terminal; no password is stored.');
    return;
  }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 21) throw new Error('Select Node 24.21 or later in the 24.x line: nvm use 24');
  await deploy(await deploymentHost(options), options);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
