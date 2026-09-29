import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export interface BackupResult {
  destination: string;
  bytes: number;
}

/**
 * Copies the live database consistently while the bot keeps running. Files rotate by UTC weekday, and every attempt prunes expired copies. Operators
 * must keep the job running and apply the same retention to off-volume snapshots.
 */
export async function backupDatabase(
  databasePath: string,
  destinationDirectory = join(dirname(resolve(databasePath)), "backups"),
  now = new Date(),
): Promise<BackupResult> {
  const source = resolve(databasePath);
  // A missed weekday job must not leave stale copies indefinitely. Prune only
  // our fixed backup names, before attempting a new copy (even if it fails).
  const cutoffMs = now.getTime() - 7 * 86_400_000;
  for (const weekday of WEEKDAYS) {
    const backup = join(destinationDirectory, `countdowns-${weekday}.db`);
    if (existsSync(backup)) {
      const info = lstatSync(backup);
      if (info.isFile() && info.mtimeMs <= cutoffMs) rmSync(backup);
    }
  }
  if (!existsSync(source)) throw new Error("DATABASE_PATH does not exist yet. Start the bot once before backing up.");
  mkdirSync(destinationDirectory, { recursive: true, mode: 0o700 });
  const destination = join(destinationDirectory, `countdowns-${WEEKDAYS[now.getUTCDay()]}.db`);
  const partial = `${destination}.partial`;
  const removePartial = () => {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${partial}${suffix}`, { force: true });
  };
  removePartial();

  // VACUUM INTO reads one consistent snapshot in a single statement, so a
  // running bot's writes neither block it nor force page-by-page restarts.
  const database = new DatabaseSync(source, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.prepare("VACUUM INTO ?").run(partial);
  } finally {
    database.close();
  }

  // The copy inherits WAL mode. Make it one self-contained file so no -wal or
  // -shm companions are left behind, then verify it before replacing the old one.
  const copy = new DatabaseSync(partial);
  try {
    copy.exec("PRAGMA journal_mode = DELETE");
    const result = copy.prepare("PRAGMA integrity_check").get();
    if (result?.integrity_check !== "ok") throw new Error("The backup copy failed its integrity check.");
    copy.close();
  } catch (error) {
    copy.close();
    removePartial();
    throw error;
  }
  chmodSync(partial, 0o600);
  renameSync(partial, destination);
  return { destination, bytes: statSync(destination).size };
}
