import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CountdownDatabase } from "../src/database.js";
import { countdown } from "./fixtures.js";

const openDatabases: CountdownDatabase[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  openDatabases.splice(0).forEach((database) => database.close());
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function database(): CountdownDatabase {
  const value = new CountdownDatabase(":memory:");
  openDatabases.push(value);
  return value;
}

describe("CountdownDatabase", () => {
  it("stores countdowns and returns due reminders", () => {
    const db = database();
    db.createCountdown(countdown(), [60_000]);
    expect(db.getCountdown("countdown-1")?.title).toBe("Launch night");
    expect(db.getDueReminders(541_000)).toEqual([{
      countdown: countdown(),
      offsetMs: 60_000,
      attemptCount: 0,
    }]);
    db.markReminderSent("countdown-1", 60_000, 541_000);
    expect(db.getDueReminders(550_000)).toEqual([]);
  });

  it("toggles subscriptions idempotently", () => {
    const db = database();
    db.createCountdown(countdown(), []);
    expect(db.toggleSubscription("countdown-1", "user-2", 2_000)).toBe(true);
    expect(db.listSubscribers("countdown-1")).toEqual(["user-2"]);
    expect(db.toggleSubscription("countdown-1", "user-2", 3_000)).toBe(false);
    expect(db.listSubscribers("countdown-1")).toEqual([]);
  });

  it("counts active capacity and subscriptions", () => {
    const db = database();
    db.createCountdown(countdown(), []);
    db.createCountdown(countdown({ id: "countdown-2", creatorId: "user-2", messageId: "message-2" }), []);
    db.toggleSubscription("countdown-1", "user-3", 2_000);
    expect(db.countActive("guild-1", undefined, 2_000)).toBe(2);
    expect(db.countActiveGlobal(2_000)).toBe(2);
    expect(db.countActive("guild-1", "creator-1", 2_000)).toBe(1);
    expect(db.isSubscribed("countdown-1", "user-3")).toBe(true);
    expect(db.countSubscribers("countdown-1")).toBe(1);
  });

  it("counts creation-rate and audible quotas without retaining expired armed rows", () => {
    const db = database();
    db.createCountdown(countdown({ sound: "beep", voiceChannelId: "voice-1", createdAtMs: 1_000 }), []);
    db.createCountdown(countdown({
      id: "countdown-2",
      messageId: "message-2",
      sound: "bell",
      voiceChannelId: "voice-2",
      endsAtMs: 1_500,
      createdAtMs: 1_100,
    }), []);
    db.createCountdown(countdown({
      id: "countdown-3",
      messageId: null,
      sound: "urgent",
      voiceChannelId: "voice-3",
      createdAtMs: 1_200,
    }), [], { armed: false });
    db.createCountdown(countdown({
      id: "countdown-4",
      messageId: "message-4",
      creatorId: "creator-2",
      sound: "silent",
      createdAtMs: 1_300,
    }), []);

    expect(db.countRecentCreations("guild-1", "creator-1", 1_100)).toBe(2);
    expect(db.countActiveAudible("guild-1", "creator-1", 2_000)).toBe(2);
    expect(db.countActiveAudible("guild-1", null, 2_000)).toBe(2);
  });

  it("finds countdowns only once they are due", () => {
    const db = database();
    db.createCountdown(countdown(), []);
    expect(db.getDueCountdowns(600_999)).toEqual([]);
    expect(db.getDueCountdowns(601_000)).toHaveLength(1);
  });

  it("excludes retries without starving another due countdown", () => {
    const db = database();
    db.createCountdown(countdown(), []);
    db.createCountdown(countdown({ id: "countdown-2", messageId: "message-2", endsAtMs: 601_001 }), []);
    expect(db.getDueCountdowns(601_001, ["countdown-1"]).map(({ id }) => id)).toEqual(["countdown-2"]);
  });

  it("deletes failed creations and their related rows", () => {
    const db = database();
    db.createCountdown(countdown(), [60_000]);
    db.toggleSubscription("countdown-1", "user-2", 2_000);
    db.deleteCountdown("countdown-1");
    expect(db.getCountdown("countdown-1")).toBeNull();
    expect(db.listSubscribers("countdown-1")).toEqual([]);
    expect(db.getDueReminders(541_000)).toEqual([]);
  });

  it("survives a database close and process-style reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "countdown-bot-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "countdowns.db");
    const first = new CountdownDatabase(path);
    first.createCountdown(countdown(), [60_000]);
    first.toggleSubscription("countdown-1", "user-2", 2_000);
    first.close();

    const reopened = new CountdownDatabase(path);
    expect(reopened.getCountdown("countdown-1")?.state).toBe("running");
    expect(reopened.getDueReminders(541_000)).toHaveLength(1);
    expect(reopened.listSubscribers("countdown-1")).toEqual(["user-2"]);
    reopened.close();
  });

  it("migrates the legacy schema without losing countdowns, reminders, or subscriptions", () => {
    const directory = mkdtempSync(join(tmpdir(), "countdown-bot-legacy-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "countdowns.db");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE countdowns (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT,
        creator_id TEXT NOT NULL,
        title TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('running', 'paused', 'completed', 'cancelled')),
        duration_ms INTEGER NOT NULL,
        remaining_ms INTEGER NOT NULL,
        started_at_ms INTEGER NOT NULL,
        ends_at_ms INTEGER,
        reminder_mode TEXT NOT NULL CHECK (reminder_mode IN ('off', 'smart')),
        sound TEXT NOT NULL CHECK (sound IN ('silent', 'beep', 'bell', 'urgent')),
        voice_channel_id TEXT,
        mention TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE countdown_reminders (
        countdown_id TEXT NOT NULL REFERENCES countdowns(id) ON DELETE CASCADE,
        offset_ms INTEGER NOT NULL,
        sent_at_ms INTEGER,
        PRIMARY KEY (countdown_id, offset_ms)
      ) STRICT;
      CREATE TABLE subscriptions (
        countdown_id TEXT NOT NULL REFERENCES countdowns(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (countdown_id, user_id)
      ) STRICT;
      INSERT INTO countdowns VALUES (
        'legacy-1', 'guild-1', 'channel-1', 'message-1', 'creator-1', 'Legacy launch',
        'running', 600000, 600000, 1000, 601000, 'smart', 'silent', NULL,
        '<@creator-1>', 1000, 1000
      );
      INSERT INTO countdown_reminders VALUES ('legacy-1', 60000, NULL);
      INSERT INTO subscriptions VALUES ('legacy-1', 'subscriber-1', 2000);
    `);
    legacy.close();

    const migrated = new CountdownDatabase(path);
    expect(migrated.getCountdown("legacy-1")).toMatchObject({
      kind: "relative",
      state: "running",
      title: "Legacy launch",
      messageId: "message-1",
    });
    expect(migrated.getDueReminders(541_000)).toMatchObject([{
      offsetMs: 60_000,
      attemptCount: 0,
    }]);
    expect(migrated.listSubscribers("legacy-1")).toEqual(["subscriber-1"]);
    expect(migrated.finalizeDueCountdowns(601_000)).toHaveLength(1);
    expect(migrated.getPendingCompletions(601_000)).toHaveLength(1);
    migrated.close();
  });

  it("migrates an existing quick-picker table to token-owned sound updates", () => {
    const directory = mkdtempSync(join(tmpdir(), "countdown-bot-picker-migration-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "countdowns.db");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE countdown_pickers (
        message_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        selected_sound TEXT NOT NULL CHECK (selected_sound IN ('silent', 'beep', 'bell', 'urgent')),
        status TEXT NOT NULL CHECK (status IN ('open', 'updating', 'consumed')),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      ) STRICT;
      INSERT INTO countdown_pickers VALUES ('picker-1', 'user-1', 'silent', 'open', 0, 0);
    `);
    legacy.close();

    const migrated = new CountdownDatabase(path);
    const updateToken = migrated.beginPickerSoundUpdate("picker-1", "user-1", "beep", 1_000);
    expect(updateToken).toEqual(expect.any(String));
    expect(migrated.finishPickerSoundUpdate(
      "picker-1",
      "user-1",
      updateToken ?? "missing",
      true,
      1_001,
    )).toBe(true);
    expect(migrated.consumePicker("picker-1", "user-1", 1_002, "beep")).toBe("beep");
    migrated.close();
  });

  it("updates control state and message IDs", () => {
    const db = database();
    db.createCountdown(countdown({ messageId: null }), []);
    db.setMessageId("countdown-1", "message-2", 2_000);
    const stored = db.getCountdown("countdown-1");
    expect(stored?.messageId).toBe("message-2");
    if (!stored) throw new Error("Expected stored countdown");
    db.updateCountdown({ ...stored, state: "paused", endsAtMs: null, remainingMs: 500_000 });
    expect(db.getCountdown("countdown-1")?.state).toBe("paused");
  });

  it("prunes terminal records after the retention window", () => {
    const db = database();
    db.createCountdown(countdown({ state: "completed", updatedAtMs: 1_000 }), []);
    expect(db.pruneTerminal(1_001)).toBe(1);
    expect(db.getCountdown("countdown-1")).toBeNull();
  });

  it("keeps draft countdowns invisible to the scheduler until their message is armed", () => {
    const db = database();
    db.createCountdown(countdown({ messageId: null }), [], { armed: false });
    expect(db.getDueCountdowns(601_000)).toEqual([]);
    expect(db.armCountdown("countdown-1", "message-1", 601_500)).toBe(true);
    expect(db.getDueCountdowns(601_500)).toHaveLength(1);
  });

  it("does not let subscriber completion delivery overlap the main completion claim", () => {
    const db = database();
    db.createCountdown(countdown(), []);
    db.setSubscription("countdown-1", "creator-1", true, 2_000);
    db.finalizeDueCountdowns(601_000);

    expect(db.claimCompletion("countdown-1", 601_000)?.id).toBe("countdown-1");
    expect(db.claimSubscriberBatch("countdown-1", 601_001)).toBeNull();

    expect(db.markCompletionDelivered("countdown-1", 601_000, 601_002)).toBe(true);
    const subscriber = db.claimSubscriberBatch("countdown-1", 601_003);
    expect(subscriber?.groups).toMatchObject([{ userId: "creator-1", offsets: [0] }]);
  });

  it("lets the deadline preempt a crashed reminder claim", () => {
    const db = database();
    db.createCountdown(countdown(), [60_000]);
    const reminder = db.claimReminderDelivery("countdown-1", 541_000);
    expect(reminder?.reminders).toHaveLength(1);

    expect(db.finalizeDueCountdowns(601_000)).toHaveLength(1);
    expect(db.getCountdown("countdown-1")?.state).toBe("completed");
    expect(db.getPendingCompletions(601_000)).toHaveLength(1);
    expect(db.finishReminderDelivery(
      "countdown-1",
      [60_000],
      reminder?.claimAtMs ?? 0,
      601_001,
    )).toBe(false);
  });

  it("atomically consumes a quick picker once and persists its selected alert", () => {
    const db = database();
    db.createPicker("picker-1", "user-1", 1_000);
    const updateToken = db.beginPickerSoundUpdate("picker-1", "user-1", "bell", 2_000);
    expect(updateToken).toEqual(expect.any(String));
    expect(db.consumePicker("picker-1", "user-1", 2_001)).toBeNull();
    expect(db.finishPickerSoundUpdate(
      "picker-1",
      "user-1",
      updateToken ?? "missing",
      true,
      2_002,
    )).toBe(true);
    expect(db.consumePicker("picker-1", "user-1", 3_000)).toBe("bell");
    expect(db.consumePicker("picker-1", "user-1", 3_001)).toBeNull();
  });

  it("rejects a stale picker update after a newer lease takes ownership", () => {
    const db = database();
    db.createPicker("picker-1", "user-1", 0);
    const firstToken = db.beginPickerSoundUpdate("picker-1", "user-1", "beep", 1_000);
    const secondToken = db.beginPickerSoundUpdate("picker-1", "user-1", "bell", 31_001);

    expect(firstToken).toEqual(expect.any(String));
    expect(secondToken).toEqual(expect.any(String));
    expect(db.finishPickerSoundUpdate(
      "picker-1",
      "user-1",
      firstToken ?? "missing",
      true,
      31_002,
    )).toBe(false);
    expect(db.finishPickerSoundUpdate(
      "picker-1",
      "user-1",
      secondToken ?? "missing",
      true,
      31_003,
    )).toBe(true);
    expect(db.consumePicker("picker-1", "user-1", 31_004, "bell")).toBe("bell");
  });

  it("recovers the sound displayed by a successful picker update after a crash", () => {
    const db = database();
    db.createPicker("picker-1", "user-1", 0);
    expect(db.beginPickerSoundUpdate("picker-1", "user-1", "urgent", 1_000))
      .toEqual(expect.any(String));

    expect(db.consumePicker("picker-1", "user-1", 1_001, "silent")).toBeNull();
    expect(db.consumePicker("picker-1", "user-1", 1_002, "urgent")).toBe("urgent");
    expect(db.consumePicker("picker-1", "user-1", 1_003, "urgent")).toBeNull();
  });

  it("finalizes due state before delivery and releases active capacity", () => {
    const db = database();
    db.createCountdown(countdown(), []);
    expect(db.finalizeDueCountdowns(601_000)).toHaveLength(1);
    expect(db.getCountdown("countdown-1")?.state).toBe("completed");
    expect(db.countActive("guild-1", "creator-1", 601_000)).toBe(0);
    expect(db.getPendingCompletions(601_000)).toHaveLength(1);
    expect(db.claimCompletion("countdown-1", 601_000)?.id).toBe("countdown-1");
    expect(db.claimCompletion("countdown-1", 601_001)).toBeNull();
  });

  it("keeps each close milestone retry on its own stable offset", () => {
    const db = database();
    db.createCountdown(countdown({ endsAtMs: 100_000 }), [61_000, 60_000]);

    const first = db.claimReminderDelivery("countdown-1", 39_000);
    expect(first?.reminders.map(({ offsetMs }) => offsetMs)).toEqual([61_000]);
    expect(db.retryReminderDelivery("countdown-1", [61_000], 39_000, 69_000, null)).toBe(true);

    const second = db.claimReminderDelivery("countdown-1", 40_000);
    expect(second?.reminders.map(({ offsetMs }) => offsetMs)).toEqual([60_000]);
    expect(db.retryReminderDelivery("countdown-1", [60_000], 40_000, 70_000, null)).toBe(true);

    const firstRetry = db.claimReminderDelivery("countdown-1", 69_000);
    expect(firstRetry?.reminders.map(({ offsetMs }) => offsetMs)).toEqual([61_000]);
  });

  it("claims at most one close milestone per subscriber and retry", () => {
    const db = database();
    db.createCountdown(countdown({ endsAtMs: 100_000 }), [61_000, 60_000]);
    db.setSubscription("countdown-1", "user-2", true, 1_000);

    expect(db.claimReminderDelivery("countdown-1", 39_000)?.reminders[0]?.offsetMs).toBe(61_000);
    expect(db.retryReminderDelivery("countdown-1", [61_000], 39_000, 69_000, null)).toBe(true);
    expect(db.claimReminderDelivery("countdown-1", 40_000)?.reminders[0]?.offsetMs).toBe(60_000);
    expect(db.retryReminderDelivery("countdown-1", [60_000], 40_000, 70_000, null)).toBe(true);

    const first = db.claimSubscriberBatch("countdown-1", 40_001);
    expect(first?.groups).toEqual([{ userId: "user-2", offsets: [61_000], attemptCount: 0 }]);
    expect(db.retrySubscriberDelivery(
      "countdown-1",
      "user-2",
      [61_000],
      40_001,
      69_000,
      null,
    )).toBe(true);
    db.releaseSubscriberBatch("countdown-1", 40_001);

    const second = db.claimSubscriberBatch("countdown-1", 40_002);
    expect(second?.groups).toEqual([{ userId: "user-2", offsets: [60_000], attemptCount: 0 }]);
  });

  it("lets a control win over an in-flight reminder delivery", () => {
    const db = database();
    db.createCountdown(countdown(), [60_000]);
    const claim = db.claimReminderDelivery("countdown-1", 541_000);
    expect(claim?.reminders.map(({ offsetMs }) => offsetMs)).toEqual([60_000]);
    const stored = db.getCountdown("countdown-1");
    if (!stored || !claim) throw new Error("Expected a claimed countdown");
    expect(db.updateCountdown({ ...stored, state: "cancelled", updatedAtMs: 541_001 })).toBe(true);
    expect(db.isReminderDeliveryClaimActive("countdown-1", [60_000], claim.claimAtMs)).toBe(false);
    expect(db.finishReminderDelivery("countdown-1", [60_000], claim.claimAtMs, 541_002)).toBe(false);
  });

  it("re-arms a superseded milestone when +1 minute lands during its delivery", () => {
    const db = database();
    db.createCountdown(countdown(), [60_000]);
    const claim = db.claimReminderDelivery("countdown-1", 541_000);
    const stored = db.getCountdown("countdown-1");
    if (!stored?.endsAtMs || !claim) throw new Error("Expected a claimed countdown");
    expect(db.updateCountdown({ ...stored, endsAtMs: stored.endsAtMs + 60_000, updatedAtMs: 541_001 })).toBe(true);
    expect(db.isReminderDeliveryClaimActive("countdown-1", [60_000], claim.claimAtMs)).toBe(false);
    expect(db.claimReminderDelivery("countdown-1", 541_002)).toBeNull();
    expect(db.claimReminderDelivery("countdown-1", stored.endsAtMs + 1)?.reminders.map(({ offsetMs }) => offsetMs))
      .toEqual([60_000]);
  });

  it("lets a control win over a subscriber batch", () => {
    const db = database();
    db.createCountdown(countdown(), [60_000]);
    db.setSubscription("countdown-1", "user-2", true, 2_000);
    db.queueSubscriberRetry("countdown-1", "user-2", [60_000], 541_000);
    expect(db.claimSubscriberBatch("countdown-1", 541_000)).not.toBeNull();
    const stored = db.getCountdown("countdown-1");
    if (!stored) throw new Error("Expected a stored countdown");
    expect(db.updateCountdown({ ...stored, state: "cancelled", updatedAtMs: 541_001 })).toBe(true);
  });

  it("uses idempotent subscription state instead of a double-click toggle", () => {
    const db = database();
    db.createCountdown(countdown(), []);
    expect(db.setSubscription("countdown-1", "user-2", true, 2_000)).toBe(true);
    expect(db.setSubscription("countdown-1", "user-2", true, 2_001)).toBe(false);
    expect(db.isSubscribed("countdown-1", "user-2")).toBe(true);
    expect(db.setSubscription("countdown-1", "user-2", false, 2_002)).toBe(true);
    expect(db.setSubscription("countdown-1", "user-2", false, 2_003)).toBe(false);
  });

  it("rejects a subscription whose active-state snapshot was finalized by another worker", () => {
    const db = database();
    db.createCountdown(countdown(), []);
    const snapshot = db.getCountdown("countdown-1");
    if (!snapshot) throw new Error("Expected stored countdown");
    db.finalizeDueCountdowns(601_000);

    expect(db.setSubscription("countdown-1", "late-user", true, 601_001, snapshot.version)).toBe(false);
    expect(db.isSubscribed("countdown-1", "late-user")).toBe(false);
  });

  it("rejects an older control write after a newer control already committed", () => {
    const db = database();
    db.createCountdown(countdown(), []);
    const firstRead = db.getCountdown("countdown-1");
    const staleRead = db.getCountdown("countdown-1");
    if (!firstRead || !staleRead) throw new Error("Expected stored countdown");

    expect(db.updateCountdown({ ...firstRead, state: "cancelled", endsAtMs: null })).toBe(true);
    expect(db.updateCountdown({ ...staleRead, endsAtMs: 661_000 })).toBe(false);
    expect(db.getCountdown("countdown-1")).toMatchObject({ state: "cancelled", version: 1 });
  });

  it("arms a draft atomically with consuming its picker and can roll both back", () => {
    const db = database();
    db.createPicker("picker-1", "user-1", 1_000);
    db.createCountdown(countdown({ messageId: null }), [], { armed: false });

    expect(db.consumePicker("picker-1", "user-1", 2_000, "silent", "countdown-1")).toBe("silent");
    expect(db.getCountdown("countdown-1")).toMatchObject({ messageId: "picker-1", version: 1 });
    expect(db.getDueCountdowns(601_000)).toHaveLength(1);

    expect(db.deleteCountdownAndReopenPickerIfUnchanged(
      "countdown-1",
      1,
      "picker-1",
      "user-1",
      "silent",
      2_001,
    )).toBe(true);
    expect(db.getCountdown("countdown-1")).toBeNull();
    expect(db.getPickerSoundIfOpen("picker-1", "user-1", 2_002)).toBe("silent");
  });

  it("persists voice retry backoff instead of reclaiming every scheduler tick", () => {
    const db = database();
    db.createCountdown(countdown({ sound: "beep", voiceChannelId: "voice-1" }), []);
    db.finalizeDueCountdowns(601_000);
    expect(db.claimNextVoiceAlert(601_000)?.id).toBe("countdown-1");
    expect(db.scheduleVoiceAlertRetry("countdown-1", 601_000, 631_000)).toBe(true);
    expect(db.claimNextVoiceAlert(630_999)).toBeNull();
    expect(db.claimNextVoiceAlert(631_000)?.id).toBe("countdown-1");
    expect(db.getVoiceAlertAttemptCount("countdown-1")).toBe(1);
  });

  it("clears persisted delivery leases that are in the future after a clock rollback", () => {
    const db = database();
    db.createCountdown(countdown({ sound: "beep", voiceChannelId: "voice-1" }), []);
    db.finalizeDueCountdowns(601_000);
    expect(db.claimNextVoiceAlert(1_000_000)?.id).toBe("countdown-1");

    expect(db.recoverFutureClaims(500_000)).toBeGreaterThan(0);
    expect(db.claimNextVoiceAlert(601_000)?.id).toBe("countdown-1");
  });

  it("does not steal a slightly future claim from an overlapping process", () => {
    const db = database();
    db.createCountdown(countdown({ sound: "beep", voiceChannelId: "voice-1" }), []);
    db.finalizeDueCountdowns(601_000);
    expect(db.claimNextVoiceAlert(1_000_001)?.id).toBe("countdown-1");

    expect(db.recoverFutureClaims(1_000_000)).toBe(0);
    expect(db.claimNextVoiceAlert(1_000_000)).toBeNull();
  });
});

describe("production data boundaries", () => {
  it("binds a database file to one Discord application across restarts", () => {
    const directory = mkdtempSync(join(tmpdir(), "countdown-app-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "countdowns.db");
    const first = new CountdownDatabase(path);
    first.bindApplication("111111111111111111");
    first.bindApplication("111111111111111111");
    first.close();
    const other = new CountdownDatabase(path);
    openDatabases.push(other);
    expect(() => other.bindApplication("222222222222222222")).toThrow("different Discord application");
  });

  it("deletes a removed server's countdowns with their milestones, subscribers, and deliveries", () => {
    const db = database();
    db.createCountdown(countdown(), [60_000]);
    db.createCountdown(countdown({ id: "other-guild", guildId: "guild-2", messageId: "message-2" }), [60_000]);
    db.setSubscription("countdown-1", "user-2", true, 2_000);
    db.finalizeDueCountdowns(601_000);
    expect(db.listGuildIds().sort()).toEqual(["guild-1", "guild-2"]);

    expect(db.countGuildCountdowns("guild-1")).toBe(1);
    expect(db.deleteGuildData("guild-1")).toBe(1);
    expect(db.countGuildCountdowns("guild-1")).toBe(0);
    expect(db.listGuildIds()).toEqual(["guild-2"]);
    expect(db.getCountdown("countdown-1")).toBeNull();
    for (const table of ["countdown_reminders", "subscriptions", "subscriber_deliveries"]) {
      const row = db.database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE countdown_id = 'countdown-1'`).get();
      expect(Number(row?.count)).toBe(0);
    }
    expect(db.getCountdown("other-guild")?.guildId).toBe("guild-2");
  });

  it("keeps per-tick voice and card lookups on their partial indexes", () => {
    const db = database();
    const indexes = (db.database.prepare("PRAGMA index_list(countdowns)").all() as Array<{ name: string; partial: number }>)
      .filter(({ partial }) => partial === 1).map(({ name }) => name).sort();
    expect(indexes).toEqual(["countdowns_card_pending_idx", "countdowns_voice_pending_idx"]);
    // INDEXED BY makes SQLite reject these queries if an index stops matching.
    expect(db.claimNextVoiceAlert(1_000_000)).toBeNull();
    expect(db.getPendingCardUpdateIds(1_000_000)).toEqual([]);
  });
});

describe("privacy deletion requests", () => {
  it("previews, then deletes a user's created countdowns, subscriptions, and menus only", () => {
    const db = database();
    db.createCountdown(countdown(), [60_000]);
    db.createCountdown(countdown({ id: "theirs", creatorId: "other", messageId: "message-2" }), []);
    db.setSubscription("theirs", "creator-1", true, 2_000);
    db.setSubscription("theirs", "someone-else", true, 2_000);
    db.createPicker("picker-1", "creator-1", 2_000);

    expect(db.deleteUserData("creator-1", true)).toEqual({ countdowns: 1, subscriptions: 1, pickers: 1 });
    expect(db.getCountdown("countdown-1")).not.toBeNull();

    expect(db.deleteUserData("creator-1")).toEqual({ countdowns: 1, subscriptions: 1, pickers: 1 });
    expect(db.getCountdown("countdown-1")).toBeNull();
    expect(db.isSubscribed("theirs", "creator-1")).toBe(false);
    expect(db.isSubscribed("theirs", "someone-else")).toBe(true);
    expect(db.getCountdown("theirs")?.creatorId).toBe("other");
    expect(db.deleteUserData("creator-1")).toEqual({ countdowns: 0, subscriptions: 0, pickers: 0 });
  });
});
