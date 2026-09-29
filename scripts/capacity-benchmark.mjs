#!/usr/bin/env node
// Offline, file-backed benchmark. Uses the production SQLite/scheduler code but no credentials or Discord network.
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir, cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { CountdownDatabase } from '../dist/src/database.js';
import { CountdownScheduler } from '../dist/src/services/reliable-scheduler.js';

const sizes = process.argv.length === 2 ? [1_000, 5_000, 10_000] : process.argv.slice(2).map(Number);
if (sizes.length === 0 || sizes.some((size) => !Number.isSafeInteger(size) || size < 1 || size > 100_000)) {
  console.error('Usage: node --expose-gc scripts/capacity-benchmark.mjs [COUNT ...] (1–100000)');
  process.exit(2);
}

const percentile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.ceil(sorted.length * fraction) - 1] * 100) / 100;
};
const mib = (bytes) => Math.round(bytes / 1_048_576 * 100) / 100;
const milli = () => performance.now();
const seed = Date.now() - 1_000;
const rows = [];
console.log('OFFLINE ONLY. No Discord REST, voice, network delay, channel limits, or Slack workload.');
for (const size of sizes) {
  const directory = mkdtempSync(join(tmpdir(), 'countdown-bench-'));
  const file = join(directory, 'countdowns.db');
  const db = new CountdownDatabase(file);
  const client = { channels: { fetch: async () => { throw Error('Unexpected Discord fetch'); } }, users: { fetch: async () => { throw Error('Unexpected Discord fetch'); } } };
  const scheduler = new CountdownScheduler(client, db, { siteBaseUrl: 'https://onlinealarmkur.com' });
  try {
    const seedStarted = milli();
    for (let index = 0; index < size; index += 1) {
      db.createCountdown({
        id: `bench-${index}`, guildId: 'bench-guild', channelId: `bench-channel-${index % 20}`,
        messageId: `bench-message-${index}`, creatorId: `bench-user-${index % 100}`, title: 'Offline capacity sample',
        kind: 'relative', state: 'running', durationMs: 30 * 86_400_000, remainingMs: 30 * 86_400_000,
        startedAtMs: seed, endsAtMs: seed + 30 * 86_400_000, reminderMode: 'off', sound: 'silent',
        voiceChannelId: null, mention: '<@123456789012345678>', createdAtMs: seed, updatedAtMs: seed, version: 0,
      }, []);
    }
    const seedMs = Math.round(milli() - seedStarted);
    if (db.countActive('bench-guild', undefined, seed) !== size) throw Error('Active count mismatch');
    const countSamples = [];
    for (let sample = 0; sample < 100; sample += 1) {
      const countStarted = milli();
      if (db.countActiveGlobal(seed) !== size) throw Error('Global active count mismatch');
      countSamples.push(milli() - countStarted);
    }
    const listStarted = milli();
    const listed = db.listActiveAll('bench-guild', seed, 100);
    if (listed.length !== Math.min(size, 100)) throw Error('Paged list mismatch');
    const listPageMs = Math.round((milli() - listStarted) * 100) / 100;
    const searchStarted = milli();
    const searchMatches = db.listActiveAll('bench-guild', seed, size)
      .filter((row) => row.title.toLowerCase().includes('offline capacity'));
    if (searchMatches.length !== size) throw Error('Full search mismatch');
    const fullSearchScanMs = Math.round((milli() - searchStarted) * 100) / 100;
    global.gc?.();
    const rssMiB = mib(process.memoryUsage().rss);
    const ticks = [];
    for (let tick = 0; tick < 50; tick += 1) {
      const started = milli();
      await scheduler.tick(seed + tick * 1_000);
      ticks.push(milli() - started);
    }
    const result = {
      active: size,
      seedMs, listPageMs, fullSearchScanMs, globalCountP95Ms: percentile(countSamples, 0.95),
      idleTickP50Ms: percentile(ticks, 0.5), idleTickP95Ms: percentile(ticks, 0.95),
      idleTickMaxMs: Math.round(Math.max(...ticks) * 100) / 100,
      rssMiB, dbMiB: mib(statSync(file).size),
    };
    rows.push(result);
    console.log(JSON.stringify(result));
  } finally {
    scheduler.stop();
    await scheduler.drain();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ platform: process.platform, architecture: process.arch, node: process.version,
  cpus: cpus().length, memoryMiB: mib(totalmem()), rows }));
