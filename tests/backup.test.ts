import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, utimesSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backupDatabase } from "../src/backup.js";
import { CountdownDatabase } from "../src/database.js";
import { countdown } from "./fixtures.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "countdown-backup-"));
  directories.push(directory);
  return directory;
}

describe("database backups", () => {
  it("copies a live WAL database consistently and rotates by weekday", async () => {
    const directory = workspace();
    const path = join(directory, "countdowns.db");
    const live = new CountdownDatabase(path);
    try {
      live.createCountdown(countdown(), [60_000]);
      const monday = await backupDatabase(path, undefined, new Date(Date.UTC(2026, 8, 21)));
      live.createCountdown(countdown({ id: "second", messageId: "message-2" }), []);
      const nextMonday = await backupDatabase(path, undefined, new Date(Date.UTC(2026, 8, 28)));
      expect(nextMonday.destination).toBe(monday.destination);
      expect(monday.destination).toBe(join(directory, "backups", "countdowns-mon.db"));
      expect(readdirSync(join(directory, "backups"))).toEqual(["countdowns-mon.db"]);
      expect(statSync(monday.destination).mode & 0o777).toBe(0o600);

      expect(monday.bytes).toBeGreaterThan(0);
      const restored = new CountdownDatabase(monday.destination);
      try {
        expect(restored.getCountdown("countdown-1")?.title).toBe("Launch night");
        expect(restored.getCountdown("second")).not.toBeNull();
      } finally { restored.close(); }
    } finally { live.close(); }
  });

  it("expires old copies even when the new backup cannot run, preserving unrelated files", async () => {
    const directory = workspace();
    const output = join(directory, "backups");
    mkdirSync(output);
    const old = join(output, "countdowns-mon.db");
    const fresh = join(output, "countdowns-tue.db");
    const unrelated = join(output, "operator-notes.db");
    for (const file of [old, fresh, unrelated]) writeFileSync(file, "fixture");
    const now = new Date();
    const eightDaysAgo = new Date(now.getTime() - 8 * 86_400_000);
    utimesSync(old, eightDaysAgo, eightDaysAgo);
    utimesSync(unrelated, eightDaysAgo, eightDaysAgo);
    await expect(backupDatabase(join(directory, "missing.db"), output, now)).rejects.toThrow("does not exist");
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  it("refuses to back up a database that does not exist", async () => {
    const directory = workspace();
    await expect(backupDatabase(join(directory, "missing.db"))).rejects.toThrow("does not exist");
    expect(existsSync(join(directory, "backups"))).toBe(false);
  });
});
