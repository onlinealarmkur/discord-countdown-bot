import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DueReminder, Sound, StoredCountdown } from "./types.js";

const DELIVERY_LEASE_MS = 120_000;
const PICKER_UPDATE_LEASE_MS = 30_000;

export interface ClaimedReminderDelivery {
  countdown: StoredCountdown;
  reminders: DueReminder[];
  claimAtMs: number;
}

export interface SubscriberDeliveryGroup {
  userId: string;
  offsets: number[];
  attemptCount: number;
}

export interface ClaimedSubscriberBatch {
  countdown: StoredCountdown;
  groups: SubscriberDeliveryGroup[];
  claimAtMs: number;
  locksCountdown: boolean;
}

export interface PickerDisplayState {
  sound: Sound;
  version: number;
}

export interface ClaimedMessageDeletion {
  messageId: string;
  channelId: string;
  attemptCount: number;
  createdAtMs: number;
  claimAtMs: number;
}

type SqlRow = Record<string, string | number | bigint | null>;

function countdownFromRow(row: SqlRow): StoredCountdown {
  return {
    id: String(row.id),
    guildId: String(row.guild_id),
    channelId: String(row.channel_id),
    messageId: row.message_id === null ? null : String(row.message_id),
    creatorId: String(row.creator_id),
    title: String(row.title),
    kind: String(row.kind) as StoredCountdown["kind"],
    state: String(row.state) as StoredCountdown["state"],
    durationMs: Number(row.duration_ms),
    remainingMs: Number(row.remaining_ms),
    startedAtMs: Number(row.started_at_ms),
    endsAtMs: row.ends_at_ms === null ? null : Number(row.ends_at_ms),
    reminderMode: String(row.reminder_mode) as StoredCountdown["reminderMode"],
    sound: String(row.sound) as StoredCountdown["sound"],
    voiceChannelId: row.voice_channel_id === null ? null : String(row.voice_channel_id),
    mention: String(row.mention),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
    version: Number(row.version),
  };
}

const COUNTDOWN_COLUMNS = `
  id, guild_id, channel_id, message_id, creator_id, title, kind, state,
  duration_ms, remaining_ms, started_at_ms, ends_at_ms, reminder_mode,
  sound, voice_channel_id, mention, created_at_ms, updated_at_ms, version
`;

export class CountdownDatabase {
  readonly database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    // Wait briefly instead of failing if an online backup holds a lock.
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS countdowns (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT,
        creator_id TEXT NOT NULL,
        title TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'relative' CHECK (kind IN ('relative', 'event')),
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
        updated_at_ms INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        armed_at_ms INTEGER,
        delivery_claimed_at_ms INTEGER,
        completion_sent_at_ms INTEGER,
        completion_attempt_count INTEGER NOT NULL DEFAULT 0,
        completion_next_attempt_at_ms INTEGER,
        card_updated_at_ms INTEGER,
        card_update_attempt_count INTEGER NOT NULL DEFAULT 0,
        card_update_next_attempt_at_ms INTEGER,
        voice_claimed_at_ms INTEGER,
        voice_alerted_at_ms INTEGER,
        voice_attempt_count INTEGER NOT NULL DEFAULT 0,
        voice_next_attempt_at_ms INTEGER
      ) STRICT;

      CREATE INDEX IF NOT EXISTS countdowns_due_idx ON countdowns (state, ends_at_ms);
      CREATE INDEX IF NOT EXISTS countdowns_guild_idx ON countdowns (guild_id, state, created_at_ms);

      CREATE TABLE IF NOT EXISTS countdown_reminders (
        countdown_id TEXT NOT NULL REFERENCES countdowns(id) ON DELETE CASCADE,
        offset_ms INTEGER NOT NULL,
        sent_at_ms INTEGER,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at_ms INTEGER,
        claimed_at_ms INTEGER,
        subscriber_snapshotted_at_ms INTEGER,
        PRIMARY KEY (countdown_id, offset_ms)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS reminders_due_idx ON countdown_reminders (sent_at_ms, offset_ms);

      CREATE TABLE IF NOT EXISTS subscriptions (
        countdown_id TEXT NOT NULL REFERENCES countdowns(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (countdown_id, user_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS countdown_pickers (
        message_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        selected_sound TEXT NOT NULL CHECK (selected_sound IN ('silent', 'beep', 'bell', 'urgent')),
        pending_sound TEXT CHECK (pending_sound IN ('silent', 'beep', 'bell', 'urgent')),
        update_token TEXT,
        status TEXT NOT NULL CHECK (status IN ('open', 'updating', 'consumed')),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 0
      ) STRICT;

      CREATE TABLE IF NOT EXISTS subscriber_deliveries (
        countdown_id TEXT NOT NULL REFERENCES countdowns(id) ON DELETE CASCADE,
        offset_ms INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at_ms INTEGER NOT NULL,
        claimed_at_ms INTEGER,
        sent_at_ms INTEGER,
        abandoned_at_ms INTEGER,
        PRIMARY KEY (countdown_id, offset_ms, user_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS message_deletions (
        message_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at_ms INTEGER NOT NULL,
        claimed_at_ms INTEGER,
        completed_at_ms INTEGER,
        abandoned_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS message_deletions_due_idx
        ON message_deletions (completed_at_ms, abandoned_at_ms, next_attempt_at_ms);
    `);

    const countdownColumns = this.database.prepare("PRAGMA table_info(countdowns)").all() as SqlRow[];
    if (!countdownColumns.some((column) => String(column.name) === "kind")) {
      this.database.exec(
        "ALTER TABLE countdowns ADD COLUMN kind TEXT NOT NULL DEFAULT 'relative' CHECK (kind IN ('relative', 'event'))",
      );
    }

    const countdownMigrations: Array<[string, string]> = [
      ["armed_at_ms", "ALTER TABLE countdowns ADD COLUMN armed_at_ms INTEGER"],
      ["delivery_claimed_at_ms", "ALTER TABLE countdowns ADD COLUMN delivery_claimed_at_ms INTEGER"],
      ["completion_sent_at_ms", "ALTER TABLE countdowns ADD COLUMN completion_sent_at_ms INTEGER"],
      ["completion_attempt_count", "ALTER TABLE countdowns ADD COLUMN completion_attempt_count INTEGER NOT NULL DEFAULT 0"],
      ["completion_next_attempt_at_ms", "ALTER TABLE countdowns ADD COLUMN completion_next_attempt_at_ms INTEGER"],
      ["card_updated_at_ms", "ALTER TABLE countdowns ADD COLUMN card_updated_at_ms INTEGER"],
      ["card_update_attempt_count", "ALTER TABLE countdowns ADD COLUMN card_update_attempt_count INTEGER NOT NULL DEFAULT 0"],
      ["card_update_next_attempt_at_ms", "ALTER TABLE countdowns ADD COLUMN card_update_next_attempt_at_ms INTEGER"],
      ["voice_claimed_at_ms", "ALTER TABLE countdowns ADD COLUMN voice_claimed_at_ms INTEGER"],
      ["voice_alerted_at_ms", "ALTER TABLE countdowns ADD COLUMN voice_alerted_at_ms INTEGER"],
      ["voice_attempt_count", "ALTER TABLE countdowns ADD COLUMN voice_attempt_count INTEGER NOT NULL DEFAULT 0"],
      ["voice_next_attempt_at_ms", "ALTER TABLE countdowns ADD COLUMN voice_next_attempt_at_ms INTEGER"],
      ["version", "ALTER TABLE countdowns ADD COLUMN version INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [name, sql] of countdownMigrations) {
      if (!countdownColumns.some((column) => String(column.name) === name)) this.database.exec(sql);
    }

    const reminderColumns = this.database.prepare("PRAGMA table_info(countdown_reminders)").all() as SqlRow[];
    const reminderMigrations: Array<[string, string]> = [
      ["attempt_count", "ALTER TABLE countdown_reminders ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0"],
      ["next_attempt_at_ms", "ALTER TABLE countdown_reminders ADD COLUMN next_attempt_at_ms INTEGER"],
      ["claimed_at_ms", "ALTER TABLE countdown_reminders ADD COLUMN claimed_at_ms INTEGER"],
      ["subscriber_snapshotted_at_ms", "ALTER TABLE countdown_reminders ADD COLUMN subscriber_snapshotted_at_ms INTEGER"],
    ];
    for (const [name, sql] of reminderMigrations) {
      if (!reminderColumns.some((column) => String(column.name) === name)) this.database.exec(sql);
    }

    const pickerColumns = this.database.prepare("PRAGMA table_info(countdown_pickers)").all() as SqlRow[];
    const pickerMigrations: Array<[string, string]> = [
      ["pending_sound", "ALTER TABLE countdown_pickers ADD COLUMN pending_sound TEXT CHECK (pending_sound IN ('silent', 'beep', 'bell', 'urgent'))"],
      ["update_token", "ALTER TABLE countdown_pickers ADD COLUMN update_token TEXT"],
      ["version", "ALTER TABLE countdown_pickers ADD COLUMN version INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [name, sql] of pickerMigrations) {
      if (!pickerColumns.some((column) => String(column.name) === name)) this.database.exec(sql);
    }

    this.database.exec(`
      UPDATE countdowns SET armed_at_ms = created_at_ms
      WHERE armed_at_ms IS NULL AND message_id IS NOT NULL;
      UPDATE countdowns
      SET card_update_next_attempt_at_ms = COALESCE(completion_sent_at_ms, updated_at_ms)
      WHERE state = 'completed' AND completion_sent_at_ms IS NOT NULL
        AND message_id IS NOT NULL AND card_updated_at_ms IS NULL
        AND card_update_next_attempt_at_ms IS NULL;
      UPDATE countdowns
      SET card_updated_at_ms = COALESCE(completion_sent_at_ms, updated_at_ms)
      WHERE state = 'completed' AND completion_sent_at_ms IS NOT NULL
        AND message_id IS NULL AND card_updated_at_ms IS NULL;
      CREATE INDEX IF NOT EXISTS countdowns_completion_due_idx
        ON countdowns (state, completion_sent_at_ms, completion_next_attempt_at_ms);
      CREATE INDEX IF NOT EXISTS countdowns_card_update_due_idx
        ON countdowns (state, card_updated_at_ms, card_update_next_attempt_at_ms);
      CREATE INDEX IF NOT EXISTS subscriber_deliveries_due_idx
        ON subscriber_deliveries (sent_at_ms, abandoned_at_ms, next_attempt_at_ms);
      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      -- Per-tick lookups must not scan the 30 days of retained history.
      -- Partial indexes hold only outstanding work; their WHERE clauses must
      -- stay textually identical to the query terms for SQLite to use them.
      CREATE INDEX IF NOT EXISTS countdowns_voice_pending_idx
        ON countdowns (ends_at_ms)
        WHERE state = 'completed' AND voice_alerted_at_ms IS NULL
          AND voice_channel_id IS NOT NULL AND sound != 'silent';
      CREATE INDEX IF NOT EXISTS countdowns_card_pending_idx
        ON countdowns (card_update_next_attempt_at_ms)
        WHERE card_updated_at_ms IS NULL AND card_update_next_attempt_at_ms IS NOT NULL;
      -- Button presses look countdowns up by their card's message.
      CREATE INDEX IF NOT EXISTS countdowns_message_idx ON countdowns (message_id);
    `);
  }

  createCountdown(
    countdown: StoredCountdown,
    reminderOffsets: number[],
    options: { armed?: boolean } = {},
  ): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO countdowns (${COUNTDOWN_COLUMNS}, armed_at_ms) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `).run(
        countdown.id,
        countdown.guildId,
        countdown.channelId,
        countdown.messageId,
        countdown.creatorId,
        countdown.title,
        countdown.kind,
        countdown.state,
        countdown.durationMs,
        countdown.remainingMs,
        countdown.startedAtMs,
        countdown.endsAtMs,
        countdown.reminderMode,
        countdown.sound,
        countdown.voiceChannelId,
        countdown.mention,
        countdown.createdAtMs,
        countdown.updatedAtMs,
        countdown.version,
        options.armed === false ? null : countdown.createdAtMs,
      );
      const insertReminder = this.database.prepare(
        `INSERT INTO countdown_reminders (
          countdown_id, offset_ms, sent_at_ms, attempt_count, next_attempt_at_ms,
          claimed_at_ms, subscriber_snapshotted_at_ms
        ) VALUES (?, ?, NULL, 0, NULL, NULL, NULL)`,
      );
      for (const offset of reminderOffsets) insertReminder.run(countdown.id, offset);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getCountdown(id: string): StoredCountdown | null {
    const row = this.database.prepare(`SELECT ${COUNTDOWN_COLUMNS} FROM countdowns WHERE id = ?`).get(id) as
      | SqlRow
      | undefined;
    return row ? countdownFromRow(row) : null;
  }

  getCountdownByMessageId(messageId: string): StoredCountdown | null {
    const row = this.database.prepare(
      `SELECT ${COUNTDOWN_COLUMNS} FROM countdowns WHERE message_id = ?`,
    ).get(messageId) as SqlRow | undefined;
    return row ? countdownFromRow(row) : null;
  }

  setMessageId(id: string, messageId: string, nowMs = Date.now()): void {
    this.database.prepare("UPDATE countdowns SET message_id = ?, updated_at_ms = ?, version = version + 1 WHERE id = ?")
      .run(messageId, nowMs, id);
  }

  armCountdown(id: string, messageId: string, nowMs = Date.now()): boolean {
    const result = this.database.prepare(`
      UPDATE countdowns
      SET message_id = ?, armed_at_ms = ?, updated_at_ms = ?, version = version + 1,
        card_updated_at_ms = NULL, card_update_attempt_count = 0,
        card_update_next_attempt_at_ms = ?
      WHERE id = ? AND armed_at_ms IS NULL
    `).run(messageId, nowMs, nowMs, nowMs, id);
    return Number(result.changes) === 1;
  }

  deleteCountdown(id: string): void {
    this.database.prepare("DELETE FROM countdowns WHERE id = ?").run(id);
  }

  /**
   * Ties this database to one Discord application. Running a test bot's token
   * against production data would deliver and purge the wrong servers' rows.
   */
  bindApplication(applicationId: string): void {
    this.database.prepare("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('application_id', ?)").run(applicationId);
    const row = this.database.prepare("SELECT value FROM app_meta WHERE key = 'application_id'").get() as SqlRow;
    if (String(row.value) !== applicationId) {
      throw new Error("DATABASE_PATH belongs to a different Discord application. Use a separate database for each bot. Nothing was changed.");
    }
  }

  listGuildIds(): string[] {
    return (this.database.prepare("SELECT DISTINCT guild_id FROM countdowns").all() as SqlRow[])
      .map((row) => String(row.guild_id));
  }

  /**
   * Honors a privacy deletion request: the user's reminder subscriptions and
   * pending DMs, open quick-button menus, and every countdown they created.
   */
  deleteUserData(userId: string, dryRun = false): { countdowns: number; subscriptions: number; pickers: number } {
    const count = (sql: string) => Number((this.database.prepare(sql).get(userId) as SqlRow).count);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const counts = {
        countdowns: count("SELECT COUNT(*) AS count FROM countdowns WHERE creator_id = ?"),
        subscriptions: count("SELECT COUNT(*) AS count FROM subscriptions WHERE user_id = ?"),
        pickers: count("SELECT COUNT(*) AS count FROM countdown_pickers WHERE owner_id = ?"),
      };
      if (!dryRun) {
        this.database.prepare("DELETE FROM subscriber_deliveries WHERE user_id = ?").run(userId);
        this.database.prepare("DELETE FROM subscriptions WHERE user_id = ?").run(userId);
        this.database.prepare("DELETE FROM countdown_pickers WHERE owner_id = ?").run(userId);
        this.database.prepare("DELETE FROM countdowns WHERE creator_id = ?").run(userId);
      }
      this.database.exec(dryRun ? "ROLLBACK" : "COMMIT");
      return counts;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  /** Deletes a removed server's countdowns; milestones, subscriptions, and deliveries cascade. */
  countGuildCountdowns(guildId: string): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM countdowns WHERE guild_id = ?").get(guildId) as SqlRow;
    return Number(row.count);
  }

  deleteGuildData(guildId: string): number {
    return Number(this.database.prepare("DELETE FROM countdowns WHERE guild_id = ?").run(guildId).changes);
  }

  deleteDraftCountdown(id: string): boolean {
    const result = this.database.prepare(
      "DELETE FROM countdowns WHERE id = ? AND armed_at_ms IS NULL",
    ).run(id);
    return Number(result.changes) === 1;
  }

  deleteCountdownIfVersion(id: string, version: number): boolean {
    const result = this.database.prepare(
      "DELETE FROM countdowns WHERE id = ? AND version = ?",
    ).run(id, version);
    return Number(result.changes) === 1;
  }

  deleteRejectedCreation(id: string, version: number): boolean {
    const result = this.database.prepare(`
      DELETE FROM countdowns WHERE id = ? AND version = ? AND state = 'running'
        AND armed_at_ms IS NOT NULL AND delivery_claimed_at_ms IS NULL
        AND card_updated_at_ms IS NULL
    `).run(id, version);
    return Number(result.changes) === 1;
  }

  /**
   * Applies a control change (pause, resume, +1 minute, cancel). It wins over any in-flight delivery claim: every
   * worker re-checks its claim before and after sending, and the card worker re-syncs to the latest version.
   */
  updateCountdown(countdown: StoredCountdown): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE countdowns SET
          message_id = ?, title = ?, kind = ?, state = ?, duration_ms = ?, remaining_ms = ?,
          started_at_ms = ?, ends_at_ms = ?, reminder_mode = ?, sound = ?,
          voice_channel_id = ?, mention = ?, updated_at_ms = ?, version = version + 1,
          delivery_claimed_at_ms = NULL,
          card_updated_at_ms = CASE WHEN message_id IS NULL THEN ? ELSE NULL END,
          card_update_attempt_count = 0,
          card_update_next_attempt_at_ms = CASE WHEN message_id IS NULL THEN NULL ELSE ? END
        WHERE id = ? AND version = ?
      `).run(
        countdown.messageId,
        countdown.title,
        countdown.kind,
        countdown.state,
        countdown.durationMs,
        countdown.remainingMs,
        countdown.startedAtMs,
        countdown.endsAtMs,
        countdown.reminderMode,
        countdown.sound,
        countdown.voiceChannelId,
        countdown.mention,
        countdown.updatedAtMs,
        countdown.updatedAtMs,
        countdown.updatedAtMs,
        countdown.id,
        countdown.version,
      );
      const updated = Number(result.changes) === 1;
      if (updated) {
        // Release rows claimed by a delivery this change superseded, so they can be sent again with the new timing.
        this.database.prepare(`
          UPDATE countdown_reminders SET claimed_at_ms = NULL
          WHERE countdown_id = ? AND sent_at_ms IS NULL
        `).run(countdown.id);
        this.database.prepare(`
          UPDATE subscriber_deliveries SET claimed_at_ms = NULL
          WHERE countdown_id = ? AND sent_at_ms IS NULL AND abandoned_at_ms IS NULL
        `).run(countdown.id);
      }
      if (updated && (countdown.state === "cancelled" || countdown.state === "completed")) {
        this.database.prepare(`
          UPDATE countdown_reminders
          SET sent_at_ms = COALESCE(sent_at_ms, ?), claimed_at_ms = NULL
          WHERE countdown_id = ?
        `).run(countdown.updatedAtMs, countdown.id);
        this.database.prepare(`
          UPDATE subscriber_deliveries
          SET abandoned_at_ms = COALESCE(abandoned_at_ms, ?), claimed_at_ms = NULL
          WHERE countdown_id = ? AND offset_ms > 0 AND sent_at_ms IS NULL
        `).run(countdown.updatedAtMs, countdown.id);
      }
      this.database.exec("COMMIT");
      return updated;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listActive(guildId: string, creatorId?: string, nowMs = Date.now()): StoredCountdown[] {
    const base = `SELECT ${COUNTDOWN_COLUMNS} FROM countdowns
      WHERE guild_id = ? AND armed_at_ms IS NOT NULL
        AND (state = 'paused' OR (state = 'running' AND ends_at_ms > ?))`;
    const rows = creatorId
      ? this.database.prepare(`${base} AND creator_id = ? ORDER BY created_at_ms DESC LIMIT 20`)
          .all(guildId, nowMs, creatorId)
      : this.database.prepare(`${base} ORDER BY created_at_ms DESC LIMIT 20`).all(guildId, nowMs);
    return (rows as SqlRow[]).map(countdownFromRow);
  }

  countActive(guildId: string, creatorId?: string, nowMs = Date.now()): number {
    const active = `(state = 'paused' OR (state = 'running' AND (armed_at_ms IS NULL OR ends_at_ms > ?)))`;
    const row = creatorId
      ? this.database.prepare(
          `SELECT COUNT(*) AS count FROM countdowns WHERE guild_id = ? AND creator_id = ? AND ${active}`,
        ).get(guildId, creatorId, nowMs)
      : this.database.prepare(
          `SELECT COUNT(*) AS count FROM countdowns WHERE guild_id = ? AND ${active}`,
        ).get(guildId, nowMs);
    return Number((row as SqlRow).count);
  }

  countActiveGlobal(nowMs = Date.now()): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM countdowns
      WHERE state = 'paused' OR (state = 'running' AND (armed_at_ms IS NULL OR ends_at_ms > ?))
    `).get(nowMs) as SqlRow;
    return Number(row.count);
  }

  listActiveAll(guildId: string, nowMs = Date.now(), limit = 100, offset = 0): StoredCountdown[] {
    const rows = this.database.prepare(`
      SELECT ${COUNTDOWN_COLUMNS} FROM countdowns
      WHERE guild_id = ? AND armed_at_ms IS NOT NULL
        AND (state = 'paused' OR (state = 'running' AND ends_at_ms > ?))
      ORDER BY created_at_ms DESC, id DESC LIMIT ? OFFSET ?
    `).all(guildId, nowMs, limit, offset) as SqlRow[];
    return rows.map(countdownFromRow);
  }

  countRecentCreations(guildId: string, creatorId: string, sinceMs: number): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM countdowns
      WHERE guild_id = ? AND creator_id = ? AND created_at_ms >= ?
    `).get(guildId, creatorId, sinceMs) as SqlRow;
    return Number(row.count);
  }

  countActiveAudible(guildId: string, creatorId: string | null, nowMs: number): number {
    const creatorFilter = creatorId ? "AND creator_id = ?" : "";
    const values = creatorId ? [guildId, nowMs, creatorId] : [guildId, nowMs];
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM countdowns
      WHERE guild_id = ? AND sound != 'silent'
        AND (state = 'paused' OR (state = 'running' AND (armed_at_ms IS NULL OR ends_at_ms > ?)))
        ${creatorFilter}
    `).get(...values) as SqlRow;
    return Number(row.count);
  }

  getDueCountdowns(nowMs: number, excludedCountdownIds: readonly string[] = []): StoredCountdown[] {
    const exclusion = excludedCountdownIds.length
      ? `AND id NOT IN (${excludedCountdownIds.map(() => "?").join(", ")})`
      : "";
    const rows = this.database.prepare(`
      SELECT ${COUNTDOWN_COLUMNS} FROM countdowns
      WHERE state = 'running' AND armed_at_ms IS NOT NULL
        AND ends_at_ms IS NOT NULL AND ends_at_ms <= ?
      ${exclusion}
      ORDER BY ends_at_ms LIMIT 50
    `).all(nowMs, ...excludedCountdownIds) as SqlRow[];
    return rows.map(countdownFromRow);
  }

  finalizeDueCountdowns(nowMs: number): StoredCountdown[] {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.database.prepare(`
        UPDATE countdowns
        SET state = 'completed', remaining_ms = 0, updated_at_ms = ?,
          completion_next_attempt_at_ms = COALESCE(completion_next_attempt_at_ms, ?),
          card_updated_at_ms = CASE WHEN message_id IS NULL THEN ? ELSE NULL END,
          card_update_next_attempt_at_ms = CASE WHEN message_id IS NULL THEN NULL ELSE ? END,
          delivery_claimed_at_ms = NULL, version = version + 1
        WHERE state = 'running' AND armed_at_ms IS NOT NULL
          AND ends_at_ms IS NOT NULL AND ends_at_ms <= ?
        RETURNING ${COUNTDOWN_COLUMNS}
      `).all(nowMs, nowMs, nowMs, nowMs, nowMs) as SqlRow[];

      for (const row of rows) {
        const countdownId = String(row.id);
        this.database.prepare(`
          UPDATE countdown_reminders
          SET sent_at_ms = COALESCE(sent_at_ms, ?), claimed_at_ms = NULL
          WHERE countdown_id = ?
        `).run(nowMs, countdownId);
        this.database.prepare(`
          UPDATE subscriber_deliveries
          SET abandoned_at_ms = COALESCE(abandoned_at_ms, ?), claimed_at_ms = NULL
          WHERE countdown_id = ? AND offset_ms > 0 AND sent_at_ms IS NULL
        `).run(nowMs, countdownId);
        this.createSubscriberDeliveries(countdownId, [0], nowMs);
      }
      this.database.exec("COMMIT");
      return rows.map(countdownFromRow);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getPendingCompletions(nowMs: number, limit = 50): StoredCountdown[] {
    const rows = this.database.prepare(`
      SELECT ${COUNTDOWN_COLUMNS} FROM countdowns
      WHERE state = 'completed' AND armed_at_ms IS NOT NULL
        AND completion_sent_at_ms IS NULL
        AND completion_next_attempt_at_ms IS NOT NULL
        AND completion_next_attempt_at_ms <= ?
        AND (delivery_claimed_at_ms IS NULL OR delivery_claimed_at_ms <= ?)
      ORDER BY ends_at_ms LIMIT ?
    `).all(nowMs, nowMs - DELIVERY_LEASE_MS, limit) as SqlRow[];
    return rows.map(countdownFromRow);
  }

  claimCompletion(countdownId: string, nowMs: number): StoredCountdown | null {
    const row = this.database.prepare(`
      UPDATE countdowns SET delivery_claimed_at_ms = ?
      WHERE id = ? AND state = 'completed' AND completion_sent_at_ms IS NULL
        AND completion_next_attempt_at_ms IS NOT NULL AND completion_next_attempt_at_ms <= ?
        AND (delivery_claimed_at_ms IS NULL OR delivery_claimed_at_ms <= ?)
      RETURNING ${COUNTDOWN_COLUMNS}
    `).get(nowMs, countdownId, nowMs, nowMs - DELIVERY_LEASE_MS) as SqlRow | undefined;
    return row ? countdownFromRow(row) : null;
  }

  markCompletionDelivered(
    countdownId: string,
    claimAtMs: number,
    nowMs: number,
    creatorDmUserId: string | null = null,
    cardAttemptAtMs = nowMs,
  ): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE countdowns
        SET completion_sent_at_ms = ?, delivery_claimed_at_ms = NULL,
          card_update_next_attempt_at_ms = CASE WHEN message_id IS NULL THEN NULL ELSE ? END,
          card_updated_at_ms = CASE WHEN message_id IS NULL THEN ? ELSE card_updated_at_ms END
        WHERE id = ? AND state = 'completed' AND delivery_claimed_at_ms = ?
      `).run(nowMs, cardAttemptAtMs, nowMs, countdownId, claimAtMs);
      if (Number(result.changes) === 1 && creatorDmUserId) {
        this.markSubscriberOffsetsDelivered(countdownId, creatorDmUserId, [0], nowMs);
      }
      this.database.exec("COMMIT");
      return Number(result.changes) === 1;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getPendingCardUpdateIds(nowMs: number, limit = 50): string[] {
    const rows = this.database.prepare(`
      SELECT id FROM countdowns INDEXED BY countdowns_card_pending_idx
      WHERE armed_at_ms IS NOT NULL AND message_id IS NOT NULL AND card_updated_at_ms IS NULL
        AND card_update_next_attempt_at_ms IS NOT NULL
        AND card_update_next_attempt_at_ms <= ?
        AND (delivery_claimed_at_ms IS NULL OR delivery_claimed_at_ms <= ?)
      ORDER BY card_update_next_attempt_at_ms LIMIT ?
    `).all(nowMs, nowMs - DELIVERY_LEASE_MS, limit) as SqlRow[];
    return rows.map((row) => String(row.id));
  }

  claimCardUpdate(countdownId: string, nowMs: number): StoredCountdown | null {
    const row = this.database.prepare(`
      UPDATE countdowns SET delivery_claimed_at_ms = ?
      WHERE id = ? AND armed_at_ms IS NOT NULL
        AND message_id IS NOT NULL AND card_updated_at_ms IS NULL
        AND card_update_next_attempt_at_ms IS NOT NULL AND card_update_next_attempt_at_ms <= ?
        AND (delivery_claimed_at_ms IS NULL OR delivery_claimed_at_ms <= ?)
      RETURNING ${COUNTDOWN_COLUMNS}
    `).get(nowMs, countdownId, nowMs, nowMs - DELIVERY_LEASE_MS) as SqlRow | undefined;
    return row ? countdownFromRow(row) : null;
  }

  finishCardUpdate(countdownId: string, claimAtMs: number, nowMs: number): boolean {
    const result = this.database.prepare(`
      UPDATE countdowns
      SET card_updated_at_ms = ?, card_update_next_attempt_at_ms = NULL,
        delivery_claimed_at_ms = NULL
      WHERE id = ? AND card_updated_at_ms IS NULL AND delivery_claimed_at_ms = ?
    `).run(nowMs, countdownId, claimAtMs);
    return Number(result.changes) === 1;
  }

  markCardSynchronized(countdownId: string, version: number, nowMs = Date.now()): boolean {
    const result = this.database.prepare(`
      UPDATE countdowns
      SET card_updated_at_ms = ?, card_update_next_attempt_at_ms = NULL,
        card_update_attempt_count = 0
      WHERE id = ? AND version = ? AND delivery_claimed_at_ms IS NULL
    `).run(nowMs, countdownId, version);
    return Number(result.changes) === 1;
  }

  scheduleCardSynchronization(countdownId: string, nowMs: number): boolean {
    const result = this.database.prepare(`
      UPDATE countdowns
      SET card_updated_at_ms = NULL, card_update_next_attempt_at_ms = ?,
        card_update_attempt_count = 0
      WHERE id = ? AND armed_at_ms IS NOT NULL AND message_id IS NOT NULL
    `).run(nowMs, countdownId);
    return Number(result.changes) === 1;
  }

  retryCardUpdate(
    countdownId: string,
    claimAtMs: number,
    nextAttemptAtMs: number,
    abandonAtMs: number | null,
  ): boolean {
    const result = this.database.prepare(`
      UPDATE countdowns
      SET card_update_attempt_count = card_update_attempt_count + 1,
        card_update_next_attempt_at_ms = CASE WHEN ? IS NULL THEN ? ELSE NULL END,
        card_updated_at_ms = ?, delivery_claimed_at_ms = NULL
      WHERE id = ? AND card_updated_at_ms IS NULL AND delivery_claimed_at_ms = ?
    `).run(abandonAtMs, nextAttemptAtMs, abandonAtMs, countdownId, claimAtMs);
    return Number(result.changes) === 1;
  }

  getCardUpdateAttemptCount(countdownId: string): number {
    const row = this.database.prepare(
      "SELECT card_update_attempt_count FROM countdowns WHERE id = ?",
    ).get(countdownId) as SqlRow | undefined;
    return row ? Number(row.card_update_attempt_count) : 0;
  }

  scheduleCompletionRetry(
    countdownId: string,
    claimAtMs: number,
    nextAttemptAtMs: number,
  ): boolean {
    const result = this.database.prepare(`
      UPDATE countdowns
      SET completion_attempt_count = completion_attempt_count + 1,
        completion_next_attempt_at_ms = ?, delivery_claimed_at_ms = NULL
      WHERE id = ? AND state = 'completed' AND delivery_claimed_at_ms = ?
    `).run(nextAttemptAtMs, countdownId, claimAtMs);
    return Number(result.changes) === 1;
  }

  renewCountdownDeliveryClaim(countdownId: string, claimAtMs: number, renewedAtMs: number): boolean {
    const result = this.database.prepare(`
      UPDATE countdowns SET delivery_claimed_at_ms = ?
      WHERE id = ? AND delivery_claimed_at_ms = ?
    `).run(renewedAtMs, countdownId, claimAtMs);
    return Number(result.changes) === 1;
  }

  isCountdownDeliveryClaimActive(countdownId: string, claimAtMs: number): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1 AS found FROM countdowns
      WHERE id = ? AND delivery_claimed_at_ms = ?
    `).get(countdownId, claimAtMs));
  }

  getCompletionAttemptCount(countdownId: string): number {
    const row = this.database.prepare(
      "SELECT completion_attempt_count FROM countdowns WHERE id = ?",
    ).get(countdownId) as SqlRow | undefined;
    return row ? Number(row.completion_attempt_count) : 0;
  }

  claimNextVoiceAlert(nowMs: number): StoredCountdown | null {
    const row = this.database.prepare(`
      UPDATE countdowns SET voice_claimed_at_ms = ?
      WHERE id = (
        SELECT id FROM countdowns INDEXED BY countdowns_voice_pending_idx
        WHERE state = 'completed' AND armed_at_ms IS NOT NULL
          AND voice_alerted_at_ms IS NULL AND voice_channel_id IS NOT NULL AND sound != 'silent'
          AND COALESCE(voice_next_attempt_at_ms, updated_at_ms) <= ?
          AND (voice_claimed_at_ms IS NULL OR voice_claimed_at_ms <= ?)
        ORDER BY ends_at_ms LIMIT 1
      ) AND voice_alerted_at_ms IS NULL
        AND (voice_claimed_at_ms IS NULL OR voice_claimed_at_ms <= ?)
      RETURNING ${COUNTDOWN_COLUMNS}
    `).get(nowMs, nowMs, nowMs - DELIVERY_LEASE_MS, nowMs - DELIVERY_LEASE_MS) as SqlRow | undefined;
    return row ? countdownFromRow(row) : null;
  }

  markVoiceAlertDelivered(countdownId: string, claimAtMs: number, nowMs: number): boolean {
    const result = this.database.prepare(`
      UPDATE countdowns
      SET voice_alerted_at_ms = ?, voice_claimed_at_ms = NULL, voice_next_attempt_at_ms = NULL
      WHERE id = ? AND voice_alerted_at_ms IS NULL AND voice_claimed_at_ms = ?
    `).run(nowMs, countdownId, claimAtMs);
    return Number(result.changes) === 1;
  }

  releaseVoiceAlertClaim(countdownId: string, claimAtMs: number): void {
    this.database.prepare(`
      UPDATE countdowns SET voice_claimed_at_ms = NULL
      WHERE id = ? AND voice_alerted_at_ms IS NULL AND voice_claimed_at_ms = ?
    `).run(countdownId, claimAtMs);
  }

  scheduleVoiceAlertRetry(
    countdownId: string,
    claimAtMs: number,
    nextAttemptAtMs: number,
  ): boolean {
    const result = this.database.prepare(`
      UPDATE countdowns
      SET voice_attempt_count = voice_attempt_count + 1,
        voice_next_attempt_at_ms = ?, voice_claimed_at_ms = NULL
      WHERE id = ? AND voice_alerted_at_ms IS NULL AND voice_claimed_at_ms = ?
    `).run(nextAttemptAtMs, countdownId, claimAtMs);
    return Number(result.changes) === 1;
  }

  getVoiceAlertAttemptCount(countdownId: string): number {
    const row = this.database.prepare(
      "SELECT voice_attempt_count FROM countdowns WHERE id = ?",
    ).get(countdownId) as SqlRow | undefined;
    return row ? Number(row.voice_attempt_count) : 0;
  }

  enqueueMessageDeletion(channelId: string, messageId: string, nowMs: number): void {
    this.database.prepare(`
      INSERT OR IGNORE INTO message_deletions (
        message_id, channel_id, attempt_count, next_attempt_at_ms,
        claimed_at_ms, completed_at_ms, abandoned_at_ms, created_at_ms
      ) VALUES (?, ?, 0, ?, NULL, NULL, NULL, ?)
    `).run(messageId, channelId, nowMs + 30_000, nowMs);
  }

  getPendingMessageDeletionIds(nowMs: number, limit = 50): string[] {
    const rows = this.database.prepare(`
      SELECT message_id FROM message_deletions
      WHERE completed_at_ms IS NULL AND abandoned_at_ms IS NULL
        AND next_attempt_at_ms <= ?
        AND (claimed_at_ms IS NULL OR claimed_at_ms <= ?)
      ORDER BY next_attempt_at_ms LIMIT ?
    `).all(nowMs, nowMs - DELIVERY_LEASE_MS, limit) as SqlRow[];
    return rows.map((row) => String(row.message_id));
  }

  claimMessageDeletion(messageId: string, nowMs: number): ClaimedMessageDeletion | null {
    const row = this.database.prepare(`
      UPDATE message_deletions SET claimed_at_ms = ?
      WHERE message_id = ? AND completed_at_ms IS NULL AND abandoned_at_ms IS NULL
        AND next_attempt_at_ms <= ?
        AND (claimed_at_ms IS NULL OR claimed_at_ms <= ?)
      RETURNING message_id, channel_id, attempt_count, created_at_ms
    `).get(nowMs, messageId, nowMs, nowMs - DELIVERY_LEASE_MS) as SqlRow | undefined;
    return row ? {
      messageId: String(row.message_id),
      channelId: String(row.channel_id),
      attemptCount: Number(row.attempt_count),
      createdAtMs: Number(row.created_at_ms),
      claimAtMs: nowMs,
    } : null;
  }

  finishMessageDeletion(messageId: string, claimAtMs: number, nowMs: number): boolean {
    const result = this.database.prepare(`
      UPDATE message_deletions
      SET completed_at_ms = ?, claimed_at_ms = NULL
      WHERE message_id = ? AND completed_at_ms IS NULL AND claimed_at_ms = ?
    `).run(nowMs, messageId, claimAtMs);
    return Number(result.changes) === 1;
  }

  retryMessageDeletion(
    messageId: string,
    claimAtMs: number,
    nextAttemptAtMs: number,
    abandonAtMs: number | null,
  ): boolean {
    const result = this.database.prepare(`
      UPDATE message_deletions
      SET attempt_count = attempt_count + 1,
        next_attempt_at_ms = CASE WHEN ? IS NULL THEN ? ELSE next_attempt_at_ms END,
        abandoned_at_ms = ?, claimed_at_ms = NULL
      WHERE message_id = ? AND completed_at_ms IS NULL AND claimed_at_ms = ?
    `).run(abandonAtMs, nextAttemptAtMs, abandonAtMs, messageId, claimAtMs);
    return Number(result.changes) === 1;
  }

  renewVoiceAlertClaim(countdownId: string, claimAtMs: number, renewedAtMs: number): boolean {
    const result = this.database.prepare(`
      UPDATE countdowns SET voice_claimed_at_ms = ?
      WHERE id = ? AND voice_alerted_at_ms IS NULL AND voice_claimed_at_ms = ?
    `).run(renewedAtMs, countdownId, claimAtMs);
    return Number(result.changes) === 1;
  }

  recoverFutureClaims(nowMs: number): number {
    const futureCutoffMs = nowMs + DELIVERY_LEASE_MS;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const countdowns = this.database.prepare(`
        UPDATE countdowns
        SET delivery_claimed_at_ms = CASE
              WHEN delivery_claimed_at_ms > ? THEN NULL ELSE delivery_claimed_at_ms END,
            voice_claimed_at_ms = CASE
              WHEN voice_claimed_at_ms > ? THEN NULL ELSE voice_claimed_at_ms END
        WHERE delivery_claimed_at_ms > ? OR voice_claimed_at_ms > ?
      `).run(futureCutoffMs, futureCutoffMs, futureCutoffMs, futureCutoffMs);
      const reminders = this.database.prepare(`
        UPDATE countdown_reminders SET claimed_at_ms = NULL WHERE claimed_at_ms > ?
      `).run(futureCutoffMs);
      const subscribers = this.database.prepare(`
        UPDATE subscriber_deliveries SET claimed_at_ms = NULL WHERE claimed_at_ms > ?
      `).run(futureCutoffMs);
      const deletions = this.database.prepare(`
        UPDATE message_deletions SET claimed_at_ms = NULL WHERE claimed_at_ms > ?
      `).run(futureCutoffMs);
      this.database.exec("COMMIT");
      return Number(countdowns.changes) + Number(reminders.changes) +
        Number(subscribers.changes) + Number(deletions.changes);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getDueReminders(nowMs: number, excludedCountdownIds: readonly string[] = []): DueReminder[] {
    const exclusion = excludedCountdownIds.length
      ? `AND c.id NOT IN (${excludedCountdownIds.map(() => "?").join(", ")})`
      : "";
    const rows = this.database.prepare(`
      SELECT ${COUNTDOWN_COLUMNS.replaceAll(/\b(\w+)\b/g, "c.$1")}, r.offset_ms, r.attempt_count
      FROM countdown_reminders r
      JOIN countdowns c ON c.id = r.countdown_id
      WHERE c.state = 'running'
        AND c.armed_at_ms IS NOT NULL
        AND c.ends_at_ms IS NOT NULL
        AND c.ends_at_ms > ?
        AND (c.delivery_claimed_at_ms IS NULL OR c.delivery_claimed_at_ms <= ?)
        AND r.sent_at_ms IS NULL
        AND c.ends_at_ms - r.offset_ms <= ?
        AND COALESCE(r.next_attempt_at_ms, c.ends_at_ms - r.offset_ms) <= ?
        AND (r.claimed_at_ms IS NULL OR r.claimed_at_ms <= ?)
        ${exclusion}
      ORDER BY c.ends_at_ms, r.offset_ms DESC
      LIMIT 100
    `).all(
      nowMs,
      nowMs - DELIVERY_LEASE_MS,
      nowMs,
      nowMs,
      nowMs - DELIVERY_LEASE_MS,
      ...excludedCountdownIds,
    ) as SqlRow[];
    return rows.map((row) => ({
      countdown: countdownFromRow(row),
      offsetMs: Number(row.offset_ms),
      attemptCount: Number(row.attempt_count),
    }));
  }

  claimReminderDelivery(countdownId: string, nowMs: number): ClaimedReminderDelivery | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const lock = this.database.prepare(`
        UPDATE countdowns SET delivery_claimed_at_ms = ?
        WHERE id = ? AND state = 'running' AND armed_at_ms IS NOT NULL
          AND ends_at_ms > ?
          AND (delivery_claimed_at_ms IS NULL OR delivery_claimed_at_ms <= ?)
      `).run(nowMs, countdownId, nowMs, nowMs - DELIVERY_LEASE_MS);
      if (Number(lock.changes) !== 1) {
        this.database.exec("ROLLBACK");
        return null;
      }

      const countdown = this.getCountdown(countdownId);
      if (!countdown?.endsAtMs) {
        this.database.exec("ROLLBACK");
        return null;
      }
      const rows = this.database.prepare(`
        SELECT offset_ms, attempt_count, subscriber_snapshotted_at_ms
        FROM countdown_reminders
        WHERE countdown_id = ? AND sent_at_ms IS NULL
          AND ? - offset_ms <= ?
          AND COALESCE(next_attempt_at_ms, ? - offset_ms) <= ?
          AND (claimed_at_ms IS NULL OR claimed_at_ms <= ?)
        ORDER BY offset_ms DESC
        LIMIT 1
      `).all(
        countdownId,
        countdown.endsAtMs,
        nowMs,
        countdown.endsAtMs,
        nowMs,
        nowMs - DELIVERY_LEASE_MS,
      ) as SqlRow[];
      if (rows.length === 0) {
        this.database.prepare(
          "UPDATE countdowns SET delivery_claimed_at_ms = NULL WHERE id = ? AND delivery_claimed_at_ms = ?",
        ).run(countdownId, nowMs);
        this.database.exec("COMMIT");
        return null;
      }

      const claimReminder = this.database.prepare(`
        UPDATE countdown_reminders SET claimed_at_ms = ?
        WHERE countdown_id = ? AND offset_ms = ? AND sent_at_ms IS NULL
      `);
      const markSnapshotted = this.database.prepare(`
        UPDATE countdown_reminders SET subscriber_snapshotted_at_ms = ?
        WHERE countdown_id = ? AND offset_ms = ? AND subscriber_snapshotted_at_ms IS NULL
      `);
      for (const row of rows) {
        const offsetMs = Number(row.offset_ms);
        claimReminder.run(nowMs, countdownId, offsetMs);
        if (row.subscriber_snapshotted_at_ms === null) {
          this.createSubscriberDeliveries(countdownId, [offsetMs], nowMs);
          markSnapshotted.run(nowMs, countdownId, offsetMs);
        }
      }
      this.database.exec("COMMIT");
      return {
        countdown,
        reminders: rows.map((row) => ({
          countdown,
          offsetMs: Number(row.offset_ms),
          attemptCount: Number(row.attempt_count),
        })),
        claimAtMs: nowMs,
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  finishReminderDelivery(
    countdownId: string,
    offsets: readonly number[],
    claimAtMs: number,
    nowMs: number,
    creatorDmUserId: string | null = null,
  ): boolean {
    return this.finishClaimedReminders(countdownId, offsets, claimAtMs, {
      sentAtMs: nowMs,
      nextAttemptAtMs: null,
      creatorDmUserId,
      collapseDueAtMs: nowMs,
    });
  }

  retryReminderDelivery(
    countdownId: string,
    offsets: readonly number[],
    claimAtMs: number,
    nextAttemptAtMs: number,
    abandonAtMs: number | null,
  ): boolean {
    return this.finishClaimedReminders(countdownId, offsets, claimAtMs, {
      sentAtMs: abandonAtMs,
      nextAttemptAtMs: abandonAtMs === null ? nextAttemptAtMs : null,
      incrementAttempt: true,
    });
  }

  renewReminderDeliveryClaim(
    countdownId: string,
    offsets: readonly number[],
    claimAtMs: number,
    renewedAtMs: number,
  ): boolean {
    if (offsets.length === 0) return false;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const countdown = this.database.prepare(`
        UPDATE countdowns SET delivery_claimed_at_ms = ?
        WHERE id = ? AND delivery_claimed_at_ms = ?
      `).run(renewedAtMs, countdownId, claimAtMs);
      const update = this.database.prepare(`
        UPDATE countdown_reminders SET claimed_at_ms = ?
        WHERE countdown_id = ? AND offset_ms = ? AND claimed_at_ms = ?
      `);
      let changed = 0;
      for (const offset of offsets) {
        changed += Number(update.run(renewedAtMs, countdownId, offset, claimAtMs).changes);
      }
      if (Number(countdown.changes) !== 1 || changed !== offsets.length) {
        this.database.exec("ROLLBACK");
        return false;
      }
      this.database.exec("COMMIT");
      return true;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  isReminderDeliveryClaimActive(
    countdownId: string,
    offsets: readonly number[],
    claimAtMs: number,
  ): boolean {
    if (offsets.length === 0) return false;
    const placeholders = offsets.map(() => "?").join(", ");
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM countdown_reminders r
      JOIN countdowns c ON c.id = r.countdown_id
      WHERE c.id = ? AND c.state = 'running' AND c.delivery_claimed_at_ms = ?
        AND r.claimed_at_ms = ? AND r.offset_ms IN (${placeholders})
    `).get(countdownId, claimAtMs, claimAtMs, ...offsets) as SqlRow;
    return Number(row.count) === offsets.length;
  }

  private finishClaimedReminders(
    countdownId: string,
    offsets: readonly number[],
    claimAtMs: number,
    result: {
      sentAtMs: number | null;
      nextAttemptAtMs: number | null;
      incrementAttempt?: boolean;
      creatorDmUserId?: string | null;
      collapseDueAtMs?: number;
    },
  ): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const update = this.database.prepare(`
        UPDATE countdown_reminders
        SET sent_at_ms = ?, next_attempt_at_ms = ?, claimed_at_ms = NULL,
          attempt_count = attempt_count + ?
        WHERE countdown_id = ? AND offset_ms = ? AND claimed_at_ms = ?
      `);
      let changed = 0;
      for (const offset of offsets) {
        changed += Number(update.run(
          result.sentAtMs,
          result.nextAttemptAtMs,
          result.incrementAttempt ? 1 : 0,
          countdownId,
          offset,
          claimAtMs,
        ).changes);
      }
      let deliveredOffsets = [...offsets];
      if (changed === offsets.length && result.sentAtMs !== null && result.collapseDueAtMs !== undefined) {
        const dueRows = this.database.prepare(`
          SELECT r.offset_ms, r.subscriber_snapshotted_at_ms
          FROM countdown_reminders r
          JOIN countdowns c ON c.id = r.countdown_id
          WHERE r.countdown_id = ? AND r.sent_at_ms IS NULL
            AND c.ends_at_ms IS NOT NULL AND c.ends_at_ms - r.offset_ms <= ?
        `).all(countdownId, result.collapseDueAtMs) as SqlRow[];
        for (const row of dueRows) {
          if (row.subscriber_snapshotted_at_ms === null) {
            this.createSubscriberDeliveries(countdownId, [Number(row.offset_ms)], result.sentAtMs);
          }
        }
        deliveredOffsets.push(...dueRows.map((row) => Number(row.offset_ms)));
        this.database.prepare(`
          UPDATE countdown_reminders
          SET sent_at_ms = ?, next_attempt_at_ms = NULL, claimed_at_ms = NULL,
            subscriber_snapshotted_at_ms = COALESCE(subscriber_snapshotted_at_ms, ?)
          WHERE countdown_id = ? AND sent_at_ms IS NULL
            AND (SELECT ends_at_ms FROM countdowns WHERE id = countdown_id) - offset_ms <= ?
        `).run(result.sentAtMs, result.sentAtMs, countdownId, result.collapseDueAtMs);
      }
      deliveredOffsets = [...new Set(deliveredOffsets)];
      if (changed === offsets.length && result.creatorDmUserId) {
        this.markSubscriberOffsetsDelivered(
          countdownId,
          result.creatorDmUserId,
          deliveredOffsets,
          result.sentAtMs ?? claimAtMs,
        );
      }
      this.database.prepare(`
        UPDATE countdowns SET delivery_claimed_at_ms = NULL
        WHERE id = ? AND delivery_claimed_at_ms = ?
      `).run(countdownId, claimAtMs);
      this.database.exec("COMMIT");
      return changed === offsets.length;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  markReminderSent(countdownId: string, offsetMs: number, nowMs = Date.now()): void {
    this.database.prepare(
      `UPDATE countdown_reminders
       SET sent_at_ms = ?, claimed_at_ms = NULL
       WHERE countdown_id = ? AND offset_ms = ?`,
    ).run(nowMs, countdownId, offsetMs);
  }

  private createSubscriberDeliveries(
    countdownId: string,
    offsets: readonly number[],
    nowMs: number,
  ): void {
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO subscriber_deliveries (
        countdown_id, offset_ms, user_id, attempt_count, next_attempt_at_ms,
        claimed_at_ms, sent_at_ms, abandoned_at_ms
      )
      SELECT ?, ?, user_id, 0, ?, NULL, NULL, NULL
      FROM subscriptions s WHERE countdown_id = ?
        AND (? = 0 OR NOT EXISTS (
          SELECT 1 FROM subscriber_deliveries d JOIN countdowns c ON c.id = d.countdown_id
          WHERE d.countdown_id = s.countdown_id AND d.user_id = s.user_id
            AND d.offset_ms > 0 AND d.abandoned_at_ms IS NULL
            AND d.sent_at_ms >= c.ends_at_ms - ?
        ))
    `);
    for (const offset of offsets) insert.run(countdownId, offset, nowMs, countdownId, offset, offset);
  }

  hasSuccessfulSubscriberDelivery(countdownId: string, userId: string, offsets: readonly number[]): boolean {
    if (offsets.length === 0) return false;
    const distinct = [...new Set(offsets)];
    const placeholders = distinct.map(() => "?").join(", ");
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM subscriber_deliveries
      WHERE countdown_id = ? AND user_id = ? AND offset_ms IN (${placeholders})
        AND sent_at_ms IS NOT NULL AND abandoned_at_ms IS NULL
    `).get(countdownId, userId, ...distinct) as SqlRow;
    return Number(row.count) === distinct.length;
  }

  getDueSubscriberCountdownIds(nowMs: number, limit = 20): string[] {
    const rows = this.database.prepare(`
      SELECT countdown_id, MIN(next_attempt_at_ms) AS due_at
      FROM subscriber_deliveries
      WHERE sent_at_ms IS NULL AND abandoned_at_ms IS NULL
        AND next_attempt_at_ms <= ?
        AND (claimed_at_ms IS NULL OR claimed_at_ms <= ?)
      GROUP BY countdown_id
      ORDER BY due_at LIMIT ?
    `).all(nowMs, nowMs - DELIVERY_LEASE_MS, limit) as SqlRow[];
    return rows.map((row) => String(row.countdown_id));
  }

  claimSubscriberBatch(
    countdownId: string,
    nowMs: number,
    maxUsers = 25,
  ): ClaimedSubscriberBatch | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const countdown = this.getCountdown(countdownId);
      if (!countdown || (countdown.state !== "running" && countdown.state !== "completed")) {
        this.database.prepare(`
          UPDATE subscriber_deliveries
          SET abandoned_at_ms = COALESCE(abandoned_at_ms, ?), claimed_at_ms = NULL
          WHERE countdown_id = ? AND sent_at_ms IS NULL
        `).run(nowMs, countdownId);
        this.database.exec("COMMIT");
        return null;
      }

      const locksCountdown = true;
      const lock = this.database.prepare(`
        UPDATE countdowns SET delivery_claimed_at_ms = ?
        WHERE id = ? AND (state = 'completed' OR (state = 'running' AND ends_at_ms > ?))
          AND (delivery_claimed_at_ms IS NULL OR delivery_claimed_at_ms <= ?)
      `).run(nowMs, countdownId, nowMs, nowMs - DELIVERY_LEASE_MS);
      if (Number(lock.changes) !== 1) {
        this.database.exec("ROLLBACK");
        return null;
      }

      const users = this.database.prepare(`
        SELECT user_id, MIN(next_attempt_at_ms) AS due_at
        FROM subscriber_deliveries
        WHERE countdown_id = ? AND sent_at_ms IS NULL AND abandoned_at_ms IS NULL
          AND next_attempt_at_ms <= ?
          AND (claimed_at_ms IS NULL OR claimed_at_ms <= ?)
        GROUP BY user_id ORDER BY due_at LIMIT ?
      `).all(countdownId, nowMs, nowMs - DELIVERY_LEASE_MS, maxUsers) as SqlRow[];
      if (users.length === 0) {
        this.database.prepare(`
          UPDATE countdowns SET delivery_claimed_at_ms = NULL
          WHERE id = ? AND delivery_claimed_at_ms = ?
        `).run(countdownId, nowMs);
        this.database.exec("COMMIT");
        return null;
      }

      const nextOffset = this.database.prepare(`
        SELECT offset_ms
        FROM subscriber_deliveries
        WHERE countdown_id = ? AND user_id = ?
          AND sent_at_ms IS NULL AND abandoned_at_ms IS NULL
          AND next_attempt_at_ms <= ?
          AND (claimed_at_ms IS NULL OR claimed_at_ms <= ?)
        ORDER BY next_attempt_at_ms, offset_ms DESC
        LIMIT 1
      `);
      const claim = this.database.prepare(`
        UPDATE subscriber_deliveries SET claimed_at_ms = ?
        WHERE countdown_id = ? AND user_id = ? AND offset_ms = ?
          AND sent_at_ms IS NULL AND abandoned_at_ms IS NULL
          AND next_attempt_at_ms <= ?
          AND (claimed_at_ms IS NULL OR claimed_at_ms <= ?)
      `);
      for (const user of users) {
        const userId = String(user.user_id);
        const next = nextOffset.get(
          countdownId,
          userId,
          nowMs,
          nowMs - DELIVERY_LEASE_MS,
        ) as SqlRow | undefined;
        if (next) {
          claim.run(
            nowMs,
            countdownId,
            userId,
            Number(next.offset_ms),
            nowMs,
            nowMs - DELIVERY_LEASE_MS,
          );
        }
      }
      const placeholders = users.map(() => "?").join(", ");
      const rows = this.database.prepare(`
        SELECT user_id, offset_ms, attempt_count
        FROM subscriber_deliveries
        WHERE countdown_id = ? AND claimed_at_ms = ? AND user_id IN (${placeholders})
        ORDER BY user_id, offset_ms
      `).all(countdownId, nowMs, ...users.map((user) => String(user.user_id))) as SqlRow[];
      const grouped = new Map<string, SubscriberDeliveryGroup>();
      for (const row of rows) {
        const userId = String(row.user_id);
        const group = grouped.get(userId) ?? { userId, offsets: [], attemptCount: 0 };
        group.offsets.push(Number(row.offset_ms));
        group.attemptCount = Math.max(group.attemptCount, Number(row.attempt_count));
        grouped.set(userId, group);
      }
      this.database.exec("COMMIT");
      return {
        countdown,
        groups: [...grouped.values()],
        claimAtMs: nowMs,
        locksCountdown,
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  finishSubscriberDelivery(
    countdownId: string,
    userId: string,
    offsets: readonly number[],
    claimAtMs: number,
    nowMs: number,
  ): boolean {
    const updated = this.updateClaimedSubscriberRows(countdownId, userId, offsets, claimAtMs, {
      sentAtMs: nowMs,
      abandonedAtMs: null,
      nextAttemptAtMs: nowMs,
      incrementAttempt: false,
    });
    if (updated && offsets.every((offset) => offset > 0)) {
      this.database.prepare(`
        UPDATE subscriber_deliveries
        SET sent_at_ms = ?, claimed_at_ms = NULL
        WHERE countdown_id = ? AND user_id = ? AND offset_ms > 0
          AND sent_at_ms IS NULL AND abandoned_at_ms IS NULL
          AND (SELECT ends_at_ms FROM countdowns WHERE id = countdown_id) - offset_ms <= ?
      `).run(nowMs, countdownId, userId, nowMs);
    }
    return updated;
  }

  retrySubscriberDelivery(
    countdownId: string,
    userId: string,
    offsets: readonly number[],
    claimAtMs: number,
    nextAttemptAtMs: number,
    abandonAtMs: number | null,
  ): boolean {
    return this.updateClaimedSubscriberRows(countdownId, userId, offsets, claimAtMs, {
      sentAtMs: null,
      abandonedAtMs: abandonAtMs,
      nextAttemptAtMs,
      incrementAttempt: true,
    });
  }

  private updateClaimedSubscriberRows(
    countdownId: string,
    userId: string,
    offsets: readonly number[],
    claimAtMs: number,
    result: {
      sentAtMs: number | null;
      abandonedAtMs: number | null;
      nextAttemptAtMs: number;
      incrementAttempt: boolean;
    },
  ): boolean {
    const update = this.database.prepare(`
      UPDATE subscriber_deliveries
      SET sent_at_ms = ?, abandoned_at_ms = ?, next_attempt_at_ms = ?, claimed_at_ms = NULL,
        attempt_count = attempt_count + ?
      WHERE countdown_id = ? AND user_id = ? AND offset_ms = ? AND claimed_at_ms = ?
    `);
    let changed = 0;
    for (const offset of offsets) {
      changed += Number(update.run(
        result.sentAtMs,
        result.abandonedAtMs,
        result.nextAttemptAtMs,
        result.incrementAttempt ? 1 : 0,
        countdownId,
        userId,
        offset,
        claimAtMs,
      ).changes);
    }
    return changed === offsets.length;
  }

  releaseSubscriberBatch(countdownId: string, claimAtMs: number): void {
    this.database.prepare(`
      UPDATE countdowns SET delivery_claimed_at_ms = NULL
      WHERE id = ? AND delivery_claimed_at_ms = ?
    `).run(countdownId, claimAtMs);
  }

  renewSubscriberBatchClaim(countdownId: string, claimAtMs: number, renewedAtMs: number): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const countdown = this.database.prepare(`
        UPDATE countdowns SET delivery_claimed_at_ms = ?
        WHERE id = ? AND delivery_claimed_at_ms = ?
      `).run(renewedAtMs, countdownId, claimAtMs);
      const deliveries = this.database.prepare(`
        UPDATE subscriber_deliveries SET claimed_at_ms = ?
        WHERE countdown_id = ? AND claimed_at_ms = ?
          AND sent_at_ms IS NULL AND abandoned_at_ms IS NULL
      `).run(renewedAtMs, countdownId, claimAtMs);
      if (Number(countdown.changes) !== 1 || Number(deliveries.changes) < 1) {
        this.database.exec("ROLLBACK");
        return false;
      }
      this.database.exec("COMMIT");
      return true;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  isSubscriberDeliveryClaimActive(
    countdownId: string,
    userId: string,
    offsets: readonly number[],
    claimAtMs: number,
  ): boolean {
    if (offsets.length === 0) return false;
    const placeholders = offsets.map(() => "?").join(", ");
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM subscriber_deliveries d
      JOIN countdowns c ON c.id = d.countdown_id
      WHERE c.id = ? AND c.delivery_claimed_at_ms = ?
        AND d.user_id = ? AND d.claimed_at_ms = ?
        AND d.sent_at_ms IS NULL AND d.abandoned_at_ms IS NULL
        AND d.offset_ms IN (${placeholders})
    `).get(countdownId, claimAtMs, userId, claimAtMs, ...offsets) as SqlRow;
    return Number(row.count) === offsets.length;
  }

  markSubscriberOffsetsDelivered(
    countdownId: string,
    userId: string,
    offsets: readonly number[],
    nowMs: number,
  ): void {
    const update = this.database.prepare(`
      UPDATE subscriber_deliveries
      SET sent_at_ms = COALESCE(sent_at_ms, ?), claimed_at_ms = NULL
      WHERE countdown_id = ? AND user_id = ? AND offset_ms = ?
    `);
    for (const offset of offsets) update.run(nowMs, countdownId, userId, offset);
  }

  queueSubscriberRetry(
    countdownId: string,
    userId: string,
    offsets: readonly number[],
    nextAttemptAtMs: number,
  ): void {
    if (offsets.length === 0) return;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const insert = this.database.prepare(`
        INSERT OR IGNORE INTO subscriber_deliveries (
          countdown_id, offset_ms, user_id, attempt_count, next_attempt_at_ms,
          claimed_at_ms, sent_at_ms, abandoned_at_ms
        ) VALUES (?, ?, ?, 1, ?, NULL, NULL, NULL)
      `);
      const update = this.database.prepare(`
        UPDATE subscriber_deliveries
        SET attempt_count = MAX(attempt_count, 1),
          next_attempt_at_ms = MAX(next_attempt_at_ms, ?), claimed_at_ms = NULL
        WHERE countdown_id = ? AND offset_ms = ? AND user_id = ?
          AND sent_at_ms IS NULL AND abandoned_at_ms IS NULL
      `);
      for (const offset of offsets) {
        insert.run(countdownId, offset, userId, nextAttemptAtMs);
        update.run(nextAttemptAtMs, countdownId, offset, userId);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  setSubscription(
    countdownId: string,
    userId: string,
    subscribed: boolean,
    nowMs = Date.now(),
    expectedVersion?: number,
  ): boolean {
    if (subscribed) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const result = this.database.prepare(`
          INSERT OR IGNORE INTO subscriptions (countdown_id, user_id, created_at_ms)
          VALUES (?, ?, ?)
        `).run(countdownId, userId, nowMs);
        if (Number(result.changes) === 1) {
          const versionGuard = expectedVersion === undefined ? "" : "AND version = ?";
          const values = expectedVersion === undefined
            ? [countdownId]
            : [countdownId, expectedVersion];
          const active = this.database.prepare(`
            UPDATE countdowns SET version = version + 1
            WHERE id = ? AND armed_at_ms IS NOT NULL AND state IN ('running', 'paused')
              ${versionGuard}
          `).run(...values);
          if (Number(active.changes) !== 1) {
            this.database.exec("ROLLBACK");
            return false;
          }
        }
        this.database.exec("COMMIT");
        return Number(result.changes) === 1;
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(
        "DELETE FROM subscriptions WHERE countdown_id = ? AND user_id = ?",
      ).run(countdownId, userId);
      this.database.prepare(`
        DELETE FROM subscriber_deliveries
        WHERE countdown_id = ? AND user_id = ? AND sent_at_ms IS NULL
      `).run(countdownId, userId);
      if (Number(result.changes) === 1) {
        this.database.prepare("UPDATE countdowns SET version = version + 1 WHERE id = ?").run(countdownId);
      }
      this.database.exec("COMMIT");
      return Number(result.changes) === 1;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Drops a subscriber whose DMs are permanently closed, so later milestones don't add invalid requests.
   * Unlike an unsubscribe press it leaves the countdown's version alone, so it never races a control change.
   */
  removeUndeliverableSubscriber(countdownId: string, userId: string): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM subscriptions WHERE countdown_id = ? AND user_id = ?").run(countdownId, userId);
      this.database.prepare(`
        DELETE FROM subscriber_deliveries
        WHERE countdown_id = ? AND user_id = ? AND sent_at_ms IS NULL
      `).run(countdownId, userId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  toggleSubscription(countdownId: string, userId: string, nowMs = Date.now()): boolean {
    const subscribed = !this.isSubscribed(countdownId, userId);
    this.setSubscription(countdownId, userId, subscribed, nowMs);
    return subscribed;
  }

  listSubscribers(countdownId: string): string[] {
    const rows = this.database.prepare(
      "SELECT user_id FROM subscriptions WHERE countdown_id = ? ORDER BY created_at_ms",
    ).all(countdownId) as SqlRow[];
    return rows.map((row) => String(row.user_id));
  }

  isSubscribed(countdownId: string, userId: string): boolean {
    return Boolean(this.database.prepare(
      "SELECT 1 AS found FROM subscriptions WHERE countdown_id = ? AND user_id = ?",
    ).get(countdownId, userId));
  }

  countSubscribers(countdownId: string): number {
    const row = this.database.prepare(
      "SELECT COUNT(*) AS count FROM subscriptions WHERE countdown_id = ?",
    ).get(countdownId) as SqlRow;
    return Number(row.count);
  }

  createPicker(messageId: string, ownerId: string, nowMs = Date.now()): void {
    this.database.prepare(`
      INSERT INTO countdown_pickers (
        message_id, owner_id, selected_sound, status, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'silent', 'open', ?, ?)
    `).run(messageId, ownerId, nowMs, nowMs);
  }

  /** False once the quick-button menu was pruned (about a day after it was opened). */
  hasPicker(messageId: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 AS found FROM countdown_pickers WHERE message_id = ?").get(messageId));
  }

  isPickerOpen(messageId: string, ownerId: string, nowMs = Date.now()): boolean {
    this.recoverStalePickerUpdate(messageId, nowMs);
    return Boolean(this.database.prepare(`
      SELECT 1 AS found FROM countdown_pickers
      WHERE message_id = ? AND owner_id = ? AND status = 'open'
    `).get(messageId, ownerId));
  }

  getPickerSoundIfOpen(messageId: string, ownerId: string, nowMs = Date.now()): Sound | null {
    this.recoverStalePickerUpdate(messageId, nowMs);
    const row = this.database.prepare(`
      SELECT selected_sound FROM countdown_pickers
      WHERE message_id = ? AND owner_id = ? AND status = 'open'
    `).get(messageId, ownerId) as SqlRow | undefined;
    return row ? String(row.selected_sound) as Sound : null;
  }

  getPickerDisplayState(messageId: string, ownerId: string, nowMs = Date.now()): PickerDisplayState | null {
    this.recoverStalePickerUpdate(messageId, nowMs);
    const row = this.database.prepare(`
      SELECT selected_sound, pending_sound, status, version FROM countdown_pickers
      WHERE message_id = ? AND owner_id = ? AND status IN ('open', 'updating')
    `).get(messageId, ownerId) as SqlRow | undefined;
    if (!row) return null;
    const sound = String(row.status) === "updating" && row.pending_sound !== null
      ? String(row.pending_sound) as Sound
      : String(row.selected_sound) as Sound;
    return { sound, version: Number(row.version) };
  }

  beginPickerSoundUpdate(
    messageId: string,
    ownerId: string,
    selectedSound: Sound,
    nowMs = Date.now(),
  ): string | null {
    this.recoverStalePickerUpdate(messageId, nowMs);
    const updateToken = randomUUID();
    const result = this.database.prepare(`
      UPDATE countdown_pickers
      SET status = 'updating', pending_sound = ?, update_token = ?, updated_at_ms = ?,
        version = version + 1
      WHERE message_id = ? AND owner_id = ? AND status = 'open'
    `).run(selectedSound, updateToken, nowMs, messageId, ownerId);
    return Number(result.changes) === 1 ? updateToken : null;
  }

  finishPickerSoundUpdate(
    messageId: string,
    ownerId: string,
    updateToken: string,
    successful: boolean,
    nowMs = Date.now(),
  ): boolean {
    if (successful) {
      const result = this.database.prepare(`
        UPDATE countdown_pickers
        SET selected_sound = pending_sound, pending_sound = NULL, update_token = NULL,
            status = 'open', updated_at_ms = ?, version = version + 1
        WHERE message_id = ? AND owner_id = ? AND status = 'updating' AND update_token = ?
      `).run(nowMs, messageId, ownerId, updateToken);
      return Number(result.changes) === 1;
    }
    const result = this.database.prepare(`
      UPDATE countdown_pickers
      SET pending_sound = NULL, update_token = NULL, status = 'open', updated_at_ms = ?,
        version = version + 1
      WHERE message_id = ? AND owner_id = ? AND status = 'updating' AND update_token = ?
    `).run(nowMs, messageId, ownerId, updateToken);
    return Number(result.changes) === 1;
  }

  consumePicker(
    messageId: string,
    ownerId: string,
    nowMs = Date.now(),
    displayedSound?: Sound,
    countdownId?: string,
  ): Sound | null {
    this.recoverStalePickerUpdate(messageId, nowMs);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(`
        SELECT selected_sound, pending_sound, status FROM countdown_pickers
        WHERE message_id = ? AND owner_id = ? AND status IN ('open', 'updating')
      `).get(messageId, ownerId) as SqlRow | undefined;
      if (!row) {
        this.database.exec("ROLLBACK");
        return null;
      }
      const status = String(row.status);
      const effectiveSound = status === "updating" && row.pending_sound !== null
        ? String(row.pending_sound) as Sound
        : String(row.selected_sound) as Sound;
      if (status === "updating" && displayedSound === undefined) {
        this.database.exec("ROLLBACK");
        return null;
      }
      if (displayedSound !== undefined && effectiveSound !== displayedSound) {
        this.database.exec("ROLLBACK");
        return null;
      }
      const result = this.database.prepare(`
        UPDATE countdown_pickers
        SET selected_sound = ?, pending_sound = NULL, update_token = NULL,
            status = 'consumed', updated_at_ms = ?, version = version + 1
        WHERE message_id = ? AND owner_id = ? AND status = ?
      `).run(effectiveSound, nowMs, messageId, ownerId, status);
      if (Number(result.changes) !== 1) {
        this.database.exec("ROLLBACK");
        return null;
      }
      if (countdownId !== undefined) {
        const armed = this.database.prepare(`
          UPDATE countdowns
          SET message_id = ?, armed_at_ms = ?, updated_at_ms = ?, version = version + 1,
            card_updated_at_ms = NULL, card_update_attempt_count = 0,
            card_update_next_attempt_at_ms = ?
          WHERE id = ? AND armed_at_ms IS NULL
        `).run(messageId, nowMs, nowMs, nowMs, countdownId);
        if (Number(armed.changes) !== 1) {
          this.database.exec("ROLLBACK");
          return null;
        }
      }
      this.database.exec("COMMIT");
      return effectiveSound;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  reopenConsumedPicker(
    messageId: string,
    ownerId: string,
    selectedSound: Sound,
    nowMs = Date.now(),
  ): boolean {
    const result = this.database.prepare(`
      UPDATE countdown_pickers
      SET selected_sound = ?, pending_sound = NULL, update_token = NULL,
          status = 'open', updated_at_ms = ?, version = version + 1
      WHERE message_id = ? AND owner_id = ? AND status = 'consumed'
    `).run(selectedSound, nowMs, messageId, ownerId);
    return Number(result.changes) === 1;
  }

  deleteCountdownAndReopenPickerIfUnchanged(
    countdownId: string,
    countdownVersion: number,
    messageId: string,
    ownerId: string,
    selectedSound: Sound,
    nowMs = Date.now(),
  ): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const removed = this.database.prepare(`
        DELETE FROM countdowns
        WHERE id = ? AND version = ? AND message_id = ? AND state = 'running'
      `).run(countdownId, countdownVersion, messageId);
      if (Number(removed.changes) !== 1) {
        this.database.exec("ROLLBACK");
        return false;
      }
      const reopened = this.database.prepare(`
        UPDATE countdown_pickers
        SET selected_sound = ?, pending_sound = NULL, update_token = NULL,
            status = 'open', updated_at_ms = ?, version = version + 1
        WHERE message_id = ? AND owner_id = ? AND status = 'consumed'
      `).run(selectedSound, nowMs, messageId, ownerId);
      if (Number(reopened.changes) !== 1) {
        this.database.exec("ROLLBACK");
        return false;
      }
      this.database.exec("COMMIT");
      return true;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private recoverStalePickerUpdate(messageId: string, nowMs: number): void {
    this.database.prepare(`
      UPDATE countdown_pickers
      SET selected_sound = COALESCE(pending_sound, selected_sound),
          pending_sound = NULL, update_token = NULL, status = 'open', updated_at_ms = ?,
          version = version + 1
      WHERE message_id = ? AND status = 'updating' AND updated_at_ms <= ?
    `).run(nowMs, messageId, nowMs - PICKER_UPDATE_LEASE_MS);
  }

  pruneTerminal(
    beforeMs: number,
    draftBeforeMs = beforeMs,
    pickerBeforeMs = beforeMs,
  ): number {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(
        "DELETE FROM countdowns WHERE state IN ('completed', 'cancelled') AND updated_at_ms < ?",
      ).run(beforeMs);
      this.database.prepare(
        "DELETE FROM countdowns WHERE armed_at_ms IS NULL AND created_at_ms < ?",
      ).run(draftBeforeMs);
      this.database.prepare(
        "DELETE FROM countdown_pickers WHERE updated_at_ms < ?",
      ).run(pickerBeforeMs);
      this.database.prepare(`
        DELETE FROM message_deletions
        WHERE COALESCE(completed_at_ms, abandoned_at_ms) < ?
      `).run(beforeMs);
      this.database.exec("COMMIT");
      return Number(result.changes);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }
}
