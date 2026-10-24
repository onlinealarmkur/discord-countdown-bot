import type { Client } from "discord.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CountdownDatabase, TERMINAL_RETENTION_MS } from "../src/database.js";
import { CountdownScheduler } from "../src/services/scheduler.js";
import { VoiceAlertQueue } from "../src/services/voice.js";
import { countdown } from "./fixtures.js";

const FINISHED_AT = 601_235;
const REFRESH_AT = FINISHED_AT + 3 * 86_400_000;
const openDatabases = new Set<CountdownDatabase>();
const directories: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(REFRESH_AT);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const db of openDatabases) db.close();
  openDatabases.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function database(path = ":memory:"): CountdownDatabase {
  const db = new CountdownDatabase(path);
  openDatabases.add(db);
  return db;
}

function completed(db: CountdownDatabase, id = "countdown-1"): void {
  db.createCountdown(countdown({ id, sound: "beep", voiceChannelId: "voice-1" }), [60_000]);
  db.setSubscription(id, "subscriber-1", true, 2_000);
  db.finalizeDueCountdowns(FINISHED_AT);
  expect(db.claimCompletion(id, FINISHED_AT)).not.toBeNull();
  expect(db.markCompletionDelivered(id, FINISHED_AT, FINISHED_AT)).toBe(true);
  db.markSubscriberOffsetsDelivered(id, "subscriber-1", [0], FINISHED_AT);
  expect(db.claimNextVoiceAlert(FINISHED_AT)?.id).toBe(id);
  expect(db.markVoiceAlertDelivered(id, FINISHED_AT, FINISHED_AT)).toBe(true);
  expect(db.claimCardUpdate(id, FINISHED_AT)).not.toBeNull();
  expect(db.finishCardUpdate(id, FINISHED_AT, FINISHED_AT)).toBe(true);
}

function row(db: CountdownDatabase, id: string): Record<string, unknown> {
  return db.database.prepare("SELECT * FROM countdowns WHERE id = ?").get(id)!;
}

function deliveries(db: CountdownDatabase): unknown[] {
  return ["countdown_reminders", "subscriptions", "subscriber_deliveries"].map((table) =>
    db.database.prepare(`SELECT * FROM ${table} ORDER BY countdown_id`).all());
}

function service(db: CountdownDatabase, edit = vi.fn().mockResolvedValue({})) {
  const send = vi.fn();
  const users = vi.fn();
  const guilds = vi.fn();
  const voice = vi.fn().mockResolvedValue(undefined);
  const client = {
    channels: { fetch: vi.fn().mockResolvedValue({ isTextBased: () => true, send, messages: { edit } }) },
    users: { fetch: users },
    guilds: { fetch: guilds },
  } as unknown as Client;
  const scheduler = new CountdownScheduler(client, db, { siteBaseUrl: "https://example.test" }, new VoiceAlertQueue(voice));
  return { scheduler, edit, send, users, guilds, voice };
}

describe("one-time fixed finish-time card refresh", () => {
  it("changes only card queue fields, preserving finish time and every alert delivery record", () => {
    const db = database();
    completed(db);
    const original = row(db, "countdown-1");
    const originalDeliveries = deliveries(db);
    expect(db.queueFixedFinishCardRefresh(REFRESH_AT)).toBe(1);
    expect(row(db, "countdown-1")).toEqual({
      ...original, card_updated_at_ms: null, card_update_attempt_count: 0,
      card_update_next_attempt_at_ms: REFRESH_AT,
    });
    expect(deliveries(db)).toEqual(originalDeliveries);
    expect(db.getPendingCompletions(REFRESH_AT)).toEqual([]);
    expect(db.getPendingCardUpdateIds(REFRESH_AT)).toEqual(["countdown-1"]);
  });

  it("leaves active, cancelled, expired, unarmed, missing-message and already-pending records alone", () => {
    const db = database();
    const variants = [
      countdown({ id: "running", endsAtMs: REFRESH_AT + 60_000 }),
      countdown({ id: "paused", state: "paused", endsAtMs: null }),
      countdown({ id: "cancelled", state: "cancelled" }),
      countdown({ id: "expired", state: "completed", updatedAtMs: REFRESH_AT - TERMINAL_RETENTION_MS - 1 }),
      countdown({ id: "missing-message", state: "completed", messageId: null }),
      countdown({ id: "unarmed", state: "completed" }),
      countdown({ id: "pending", state: "completed" }),
    ];
    for (const value of variants) {
      db.createCountdown(value, [], { armed: value.id !== "unarmed" });
      db.database.prepare("UPDATE countdowns SET card_updated_at_ms = ? WHERE id = ?").run(FINISHED_AT, value.id);
    }
    db.scheduleCardSynchronization("pending", REFRESH_AT + 120_000);
    db.database.prepare("UPDATE countdowns SET card_update_attempt_count = 4, delivery_claimed_at_ms = ? WHERE id = 'pending'").run(REFRESH_AT);
    const before = variants.map(({ id }) => row(db, id));
    expect(db.queueFixedFinishCardRefresh(REFRESH_AT)).toBe(0);
    expect(variants.map(({ id }) => row(db, id))).toEqual(before);
  });

  it("includes the exact retention boundary and preserves an existing delivery lease", () => {
    const db = database();
    completed(db);
    const refreshAt = FINISHED_AT + TERMINAL_RETENTION_MS;
    db.database.prepare("UPDATE countdowns SET delivery_claimed_at_ms = ?").run(refreshAt);
    expect(db.queueFixedFinishCardRefresh(refreshAt)).toBe(1);
    expect(db.getPendingCardUpdateIds(refreshAt)).toEqual([]);
    expect(db.getPendingCardUpdateIds(refreshAt + 120_000)).toEqual(["countdown-1"]);
    expect(db.getCountdown("countdown-1")?.updatedAtMs).toBe(FINISHED_AT);
  });

  it("persists the queue and marker across restart, without requeueing cards again", () => {
    const directory = mkdtempSync(join(tmpdir(), "countdown-card-refresh-"));
    directories.push(directory);
    const path = join(directory, "countdowns.db");
    const db = database(path);
    completed(db);
    expect(db.queueFixedFinishCardRefresh(REFRESH_AT)).toBe(1);
    db.close();
    openDatabases.delete(db);
    const reopened = database(path);
    expect(reopened.getPendingCardUpdateIds(REFRESH_AT)).toEqual(["countdown-1"]);
    expect(reopened.claimCardUpdate("countdown-1", REFRESH_AT)).not.toBeNull();
    reopened.finishCardUpdate("countdown-1", REFRESH_AT, REFRESH_AT);
    completed(reopened, "new-card");
    expect(reopened.queueFixedFinishCardRefresh(REFRESH_AT + 1_000)).toBe(0);
    expect(reopened.getPendingCardUpdateIds(REFRESH_AT + 1_000)).toEqual([]);
  });

  it("rolls back the marker if queueing fails, so startup can safely retry", () => {
    const db = database();
    completed(db);
    db.database.exec(`CREATE TRIGGER fail_refresh BEFORE UPDATE OF card_updated_at_ms ON countdowns
      BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;`);
    expect(() => db.queueFixedFinishCardRefresh(REFRESH_AT)).toThrow("simulated write failure");
    expect(db.getPendingCardUpdateIds(REFRESH_AT)).toEqual([]);
    db.database.exec("DROP TRIGGER fail_refresh");
    expect(db.queueFixedFinishCardRefresh(REFRESH_AT)).toBe(1);
  });

  it("edits the original message with a fixed timestamp and never replays text, DM or voice alerts", async () => {
    const db = database();
    completed(db);
    const originalDeliveries = deliveries(db);
    db.queueFixedFinishCardRefresh(REFRESH_AT);
    const app = service(db);
    await app.scheduler.tick(REFRESH_AT);
    await app.scheduler.tick(REFRESH_AT + 62_000);
    await app.scheduler.drain();
    expect(app.edit).toHaveBeenCalledOnce();
    expect(app.edit.mock.calls[0]?.[0]).toBe("message-1");
    const payload = app.edit.mock.calls[0]?.[1];
    expect(payload).toMatchObject({ content: null, allowedMentions: { parse: [] } });
    expect(payload.embeds[0].toJSON().description).toBe("Finished at <t:601:t> • <t:601:d>");
    expect(app.send).not.toHaveBeenCalled();
    expect(app.users).not.toHaveBeenCalled();
    expect(app.guilds).not.toHaveBeenCalled();
    expect(app.voice).not.toHaveBeenCalled();
    expect(deliveries(db)).toEqual(originalDeliveries);
    expect(db.getCountdown("countdown-1")?.updatedAtMs).toBe(FINISHED_AT);
    expect(db.getPendingCardUpdateIds(REFRESH_AT + 62_000)).toEqual([]);
  });

  it("retries transient edit failures even when the countdown finished days ago", async () => {
    const db = database();
    completed(db);
    db.queueFixedFinishCardRefresh(REFRESH_AT);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = service(db, vi.fn().mockRejectedValueOnce(new Error("temporary outage")).mockResolvedValue({}));
    await app.scheduler.tick(REFRESH_AT);
    await app.scheduler.tick(REFRESH_AT + 29_999);
    expect(app.edit).toHaveBeenCalledOnce();
    await app.scheduler.tick(REFRESH_AT + 30_000);
    expect(app.edit).toHaveBeenCalledTimes(2);
    expect(db.getPendingCardUpdateIds(REFRESH_AT + 60_000)).toEqual([]);
    expect(app.send).not.toHaveBeenCalled();
    expect(app.users).not.toHaveBeenCalled();
  });

  it.each([10003, 10008, 50001, 50013])("skips a missing or inaccessible card (Discord %s) without sending a replacement", async (code) => {
    const db = database();
    completed(db);
    db.queueFixedFinishCardRefresh(REFRESH_AT);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = service(db, vi.fn().mockRejectedValue({ code }));
    await app.scheduler.tick(REFRESH_AT);
    await app.scheduler.tick(REFRESH_AT + 60_000);
    expect(app.edit).toHaveBeenCalledOnce();
    expect(db.getPendingCardUpdateIds(REFRESH_AT + 60_000)).toEqual([]);
    expect(app.send).not.toHaveBeenCalled();
    expect(app.users).not.toHaveBeenCalled();
  });

  it("abandons persistent transient failures after eight attempts", async () => {
    const db = database();
    completed(db);
    db.queueFixedFinishCardRefresh(REFRESH_AT);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = service(db, vi.fn().mockRejectedValue(new Error("outage")));
    let tickAt = REFRESH_AT;
    for (let attempt = 0; attempt < 8; attempt++) {
      await app.scheduler.tick(tickAt);
      tickAt += 30_000 * 2 ** attempt;
    }
    await app.scheduler.tick(tickAt);
    expect(app.edit).toHaveBeenCalledTimes(8);
    expect(db.getPendingCardUpdateIds(tickAt)).toEqual([]);
    expect(app.send).not.toHaveBeenCalled();
    expect(app.users).not.toHaveBeenCalled();
  });
});
