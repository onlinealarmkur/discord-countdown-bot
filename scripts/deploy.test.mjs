import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { deploy, deploymentHost, parseOptions, runCommand, validateHost } from './deploy.mjs';

const directories = [];
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const host = '192.0.2.10';
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'discord-deploy-command-'));
  directories.push(root);
  await mkdir(join(root, 'deploy'));
  for (const name of ['digitalocean-upload.sh', 'digitalocean-setup.sh', 'cleanup.mjs']) await writeFile(join(root, 'deploy', name), '// fixture');
  const identity = join(root, 'test-identity');
  await writeFile(identity, 'Not an SSH key. No connections are made by these tests.');
  await writeFile(join(root, 'deploy.config.json'), JSON.stringify({ serverIp: host }));
  return { projectRoot: root, identity, log: () => {} };
}

test('accepts canonical IPv4 only and rejects commands, options and URLs', () => {
  assert.equal(validateHost(host), host);
  for (const value of ['', undefined, 123, '256.1.1.1', '1.2.3', '01.2.3.4', 'https://192.0.2.10', 'deploy@192.0.2.10', '::1', '-oProxyCommand=anything', '192.0.2.10;id', '$(id)', '192.0.2.10\n']) {
    assert.throws(() => validateHost(value));
  }
});

test('supports deploy/plan/help and rejects unknown options', () => {
  assert.equal(parseOptions(['--host', host, '--dry-run']).host, host);
  assert.equal(parseOptions(['-h']).help, true);
  for (const args of [['--rollback'], ['--force'], ['--host'], ['extra']]) assert.throws(() => parseOptions(args));
});

test('loads a private host setting and supports an explicit override', async () => {
  const f = await fixture();
  assert.equal(await deploymentHost({}, f.projectRoot), host);
  assert.equal(await deploymentHost({ host: '192.0.2.20' }, '/nonexistent'), '192.0.2.20');
});

test('missing, malformed and invalid configuration fail without exposing contents', async () => {
  const f = await fixture();
  await rm(join(f.projectRoot, 'deploy.config.json'));
  await assert.rejects(deploymentHost({}, f.projectRoot), /Missing local/);
  await writeFile(join(f.projectRoot, 'deploy.config.json'), 'not JSON with private-data');
  await assert.rejects(deploymentHost({}, f.projectRoot), error => !error.message.includes('private-data'));
  await writeFile(join(f.projectRoot, 'deploy.config.json'), '{}');
  await assert.rejects(deploymentHost({}, f.projectRoot), /plain IPv4/);
});

test('dry run invokes nothing and needs no credentials or operational files', async () => {
  const logs = [];
  await deploy(host, { 'dry-run': true }, { projectRoot: '/nonexistent', identity: '/nonexistent', run: () => assert.fail('Dry run executed a command'), log: line => logs.push(line) });
  assert.ok(logs.some(line => line.includes('No commands')));
});

test('one command runs the verified upload before the interactive server update', async () => {
  const f = await fixture();
  const calls = [];
  await deploy(host, {}, { ...f, run: async (command, args, options) => calls.push({ command, args, options }) });
  assert.deepEqual(calls[0], { command: 'bash', args: [join(f.projectRoot, 'deploy/digitalocean-upload.sh'), host], options: { cwd: f.projectRoot } });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].command, 'ssh');
  assert.ok(calls[1].args.includes('-t'));
  assert.ok(calls[1].args.includes('StrictHostKeyChecking=yes'));
  assert.ok(calls[1].args.includes('IdentitiesOnly=yes'));
  assert.ok(calls[1].args.includes(f.identity));
  assert.equal(calls[1].args.at(-2), `deploy@${host}`);
  assert.equal(calls[1].args.at(-1), 'sudo bash /home/deploy/countdown-bot/deploy/digitalocean-setup.sh update');
});

test('failed verification/upload prevents the remote update', async () => {
  const f = await fixture();
  const calls = [];
  await assert.rejects(deploy(host, {}, { ...f, run: async command => { calls.push(command); throw new Error('Upload failed'); } }), /Upload failed/);
  assert.deepEqual(calls, ['bash']);
});

test('failed remote update is not reported as successful and is not blindly retried', async () => {
  const f = await fixture();
  const calls = [];
  const logs = [];
  await assert.rejects(deploy(host, {}, { ...f, log: line => logs.push(line), run: async command => {
    calls.push(command);
    if (command === 'ssh') throw new Error('Server update failed');
  } }), /Server update failed/);
  assert.deepEqual(calls, ['bash', 'ssh']);
  assert.ok(!logs.some(line => line.includes('deployment passed')));
});

for (const missing of ['digitalocean-upload.sh', 'digitalocean-setup.sh', 'cleanup.mjs', 'identity']) {
  test(`missing ${missing} fails before any commands run`, async () => {
    const f = await fixture();
    await rm(missing === 'identity' ? f.identity : join(f.projectRoot, 'deploy', missing));
    await assert.rejects(deploy(host, {}, { ...f, run: () => assert.fail('Unexpected command') }));
  });
}

test('subprocess runner propagates success, failure and spawn errors', async () => {
  await runCommand(process.execPath, ['-e', 'process.exit(0)']);
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.exit(7)']), /failed \(7\)/);
  await assert.rejects(runCommand('/nonexistent/discord-deploy-command', []));
});

test('host configuration stays Git-ignored and the public npm entry points exist', async () => {
  const result = spawnSync('git', ['check-ignore', '--no-index', 'deploy.config.json'], { cwd: projectRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const pkg = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.deploy, 'node scripts/deploy.mjs');
  assert.equal(pkg.scripts['deploy:plan'], 'node scripts/deploy.mjs --dry-run');
  assert.ok(pkg.scripts.verify.includes('npm run test:deploy'));
});
