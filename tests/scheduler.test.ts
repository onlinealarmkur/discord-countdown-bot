import type { Client } from "discord.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CountdownDatabase } from "../src/database.js";
import { deliveryNonce } from "../src/discord/delivery-nonce.js";
import { CountdownScheduler } from "../src/services/scheduler.js";
import { VoiceAlertQueue } from "../src/services/voice.js";
import { countdown } from "./fixtures.js";

const openDatabases: CountdownDatabase[] = [];

// Explicit tick timestamps are logical time; keep sub-millisecond retry boundary
// assertions independent of CPU/load. Individual delay tests advance this clock.
beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  openDatabases.splice(0).forEach((database) => database.close());
});

function database(): CountdownDatabase {
  const value = new CountdownDatabase(":memory:");
  openDatabases.push(value);
  return value;
}

function scheduler(client: Client, db: CountdownDatabase): CountdownScheduler {
  return new CountdownScheduler(client, db, { siteBaseUrl: "https://onlinealarmkur.com" });
}

describe("CountdownScheduler", () => {
  it("completes after channel delivery even if auxiliary delivery fails", async () => {
    const db = database();
    db.createCountdown(countdown(), []);
    db.toggleSubscription("countdown-1", "subscriber-1", 2_000);
    const channelSend = vi.fn().mockResolvedValue({});
    const messageEdit = vi.fn().mockRejectedValue(new Error("message deleted"));
    const subscriberSend = vi.fn().mockRejectedValue(new Error("DMs disabled"));
    const client = {
      channels: { fetch: vi.fn().mockResolvedValue({
        isTextBased: () => true,
        send: channelSend,
        messages: { edit: (_id: string, payload: any) => messageEdit(payload), fetch: vi.fn().mockResolvedValue({ edit: messageEdit }) },
      }) },
      users: { fetch: vi.fn().mockResolvedValue({ send: subscriberSend }) },
      guilds: { fetch: vi.fn() },
    } as unknown as Client;
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const service = scheduler(client, db);
    await service.tick(601_000);
    await service.tick(602_000);
    expect(channelSend).toHaveBeenCalledOnce();
    expect(subscriberSend).toHaveBeenCalledOnce();
    expect(messageEdit).toHaveBeenCalledOnce();
    expect(db.getCountdown("countdown-1")?.state).toBe("completed");
  });

  it("retries a transient completed-card edit failure", async () => {
    const db = database();
    db.createCountdown(countdown(), []);
    const messageEdit = vi.fn()
      .mockRejectedValueOnce(new Error("temporary Discord failure"))
      .mockResolvedValue({});
    const client = {
      channels: { fetch: vi.fn().mockResolvedValue({
        isTextBased: () => true,
        send: vi.fn().mockResolvedValue({}),
        messages: { edit: (_id: string, payload: any) => messageEdit(payload), fetch: vi.fn().mockResolvedValue({ edit: messageEdit }) },
      }) },
      users: { fetch: vi.fn() },
      guilds: { fetch: vi.fn() },
    } as unknown as Client;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const service = scheduler(client, db);

    await service.tick(601_000);
    expect(messageEdit).toHaveBeenCalledOnce();
    await service.tick(630_000);
    expect(messageEdit).toHaveBeenCalledOnce();
    await service.tick(632_000);
    expect(messageEdit).toHaveBeenCalledTimes(2);
    expect(db.getPendingCardUpdateIds(700_000)).toEqual([]);
  });

  it("updates the completed card even when every completion notification is undeliverable", async () => {
    const db = database();
    db.createCountdown(countdown(), []);
    const messageEdit = vi.fn().mockResolvedValue({});
    const channelSend = vi.fn().mockRejectedValue(new Error("missing Send Messages"));
    const client = {
      channels: { fetch: vi.fn().mockResolvedValue({
        isTextBased: () => true,
        send: channelSend,
        messages: { edit: (_id: string, payload: any) => messageEdit(payload), fetch: vi.fn().mockResolvedValue({ edit: messageEdit }) },
      }) },
      users: { fetch: vi.fn().mockRejectedValue(new Error("DMs disabled")) },
      guilds: { fetch: vi.fn() },
    } as unknown as Client;
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await scheduler(client, db).tick(601_000);

    expect(channelSend).toHaveBeenCalledOnce();
    expect(messageEdit).toHaveBeenCalledOnce();
    const card = messageEdit.mock.calls[0]?.[0] as { embeds?: Array<{ toJSON(): any }> };
    const fields = card.embeds?.[0]?.toJSON().fields as Array<{ name: string; value: string }>;
    expect(fields.find(({ name }) => name === "Status")?.value).toBe("Time's up");
    expect(db.getCountdown("countdown-1")?.state).toBe("completed");
    expect(db.database.prepare(`
      SELECT completion_sent_at_ms, completion_next_attempt_at_ms
      FROM countdowns WHERE id = 'countdown-1'
    `).get()).toMatchObject({
      completion_sent_at_ms: null,
      completion_next_attempt_at_ms: expect.any(Number),
    });
    expect(db.getPendingCardUpdateIds(631_000)).toEqual([]);
  });

  it("clears quick-picker text when durable recovery publishes an armed card", async () => {
    const db = database();
    db.createPicker("picker-1", "creator-1", 1_000);
    db.createCountdown(countdown({ messageId: null }), [], { armed: false });
    expect(db.consumePicker("picker-1", "creator-1", 2_000, "silent", "countdown-1")).toBe("silent");
    const messageEdit = vi.fn().mockResolvedValue({});
    const client = {
      channels: { fetch: vi.fn().mockResolvedValue({
        isTextBased: () => true,
        messages: { edit: (_id: string, payload: any) => messageEdit(payload), fetch: vi.fn().mockResolvedValue({ edit: messageEdit }) },
      }) },
      users: { fetch: vi.fn() },
      guilds: { fetch: vi.fn() },
    } as unknown as Client;

    await scheduler(client, db).tick(2_000);
    expect(messageEdit).toHaveBeenCalledWith(expect.objectContaining({ content: null }));
    expect(db.getPendingCardUpdateIds(3_000)).toEqual([]);
  });

  it("repairs an old card writer that lands after a newer completion card", async () => {
    const db = database();
    db.createCountdown(countdown({ endsAtMs: 10_000 }), []);
    db.scheduleCardSynchronization("countdown-1", 2_000);
    let releaseOldEdit: () => void = () => undefined;
    const oldEdit = new Promise<void>((resolve) => { releaseOldEdit = resolve; });
    const visibleStates: string[] = [];
    const messageEdit = vi.fn().mockImplementation(async (payload: { embeds?: Array<{ toJSON(): any }> }) => {
      const fields = payload.embeds?.[0]?.toJSON().fields as Array<{ name: string; value: string }>;
      const state = fields.find(({ name }) => name === "Status")?.value ?? "unknown";
      if (messageEdit.mock.calls.length === 1) {
        await oldEdit;
      }
      visibleStates.push(state);
      return {};
    });
    const channel = {
      isTextBased: () => true,
      send: vi.fn().mockResolvedValue({}),
      messages: { edit: (_id: string, payload: any) => messageEdit(payload), fetch: vi.fn().mockResolvedValue({ edit: messageEdit }) },
    };
    const client = {
      channels: { fetch: vi.fn().mockResolvedValue(channel) },
      users: { fetch: vi.fn() },
      guilds: { fetch: vi.fn() },
    } as unknown as Client;
    const oldScheduler = scheduler(client, db);
    const newScheduler = scheduler(client, db);

    const oldTick = oldScheduler.tick(2_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(messageEdit).toHaveBeenCalledOnce();
    const newTick = newScheduler.tick(10_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(messageEdit.mock.calls.length).toBeGreaterThanOrEqual(2);
    releaseOldEdit();
    await Promise.all([oldTick, newTick]);

    expect(visibleStates.at(-1)).toBe("Time's up");
    expect(db.getCountdown("countdown-1")?.state).toBe("completed");
    expect(db.getPendingCardUpdateIds(20_000)).toEqual([]);
  });

  it("falls back to a creator DM when the channel is unavailable", async () => {
    const db = database();
    db.createCountdown(countdown(), []);
    const creatorSend = vi.fn().mockResolvedValue({});
    const userFetch = vi.fn().mockResolvedValue({ send: creatorSend });
    const client = {
      channels: { fetch: vi.fn().mockRejectedValue(new Error("missing access")) },
      users: { fetch: userFetch },
      guilds: { fetch: vi.fn() },
    } as unknown as Client;
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await scheduler(client, db).tick(601_000);
    expect(userFetch).toHaveBeenCalledWith("creator-1");
    expect(creatorSend).toHaveBeenCalledOnce();
    expect(db.getCountdown("countdown-1")?.state).toBe("completed");
  });

  it("renders hostile labels literally in channel alerts and subscriber DMs", async () => {
    const db = database();
    db.createCountdown(countdown({ title: "[Claim](https://evil.example)\n<@123>" }), []);
    db.setSubscription("countdown-1", "subscriber-1", true, 2_000);
    const channelSend = vi.fn().mockResolvedValue({});
    const subscriberSend = vi.fn().mockResolvedValue({});
    const client = {
      channels: { fetch: vi.fn().mockResolvedValue({
        isTextBased: () => true,
        send: channelSend,
        messages: { edit: vi.fn().mockResolvedValue({}), fetch: vi.fn().mockResolvedValue({ edit: vi.fn().mockResolvedValue({}) }) },
      }) },
      users: { fetch: vi.fn().mockResolvedValue({ send: subscriberSend }) },
      guilds: { fetch: vi.fn() },
    } as unknown as Client;

    await scheduler(client, db).tick(601_000);
    const outputs = [channelSend.mock.calls[0]?.[0].content, subscriberSend.mock.calls[0]?.[0].content];
    for (const content of outputs) {
      expect(content).not.toContain("](https://");
      expect(content).not.toContain("https://");
      expect(content).not.toContain("<@123>");
      expect(content).not.toContain("\n");
    }
  });

  it("keeps an undelivered completion pending and follows its persisted retry schedule", async () => {
    const db = database();
    db.createCountdown(countdown(), []);
    const channelFetch = vi.fn().mockRejectedValue(new Error("missing access"));
    const userFetch = vi.fn().mockRejectedValue(new Error("DMs disabled"));
    const client = {
      channels: { fetch: channelFetch },
      users: { fetch: userFetch },
      guilds: { fetch: vi.fn() },
    } as unknown as Client;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const service = scheduler(client, db);

    await service.tick(601_000);
    const firstRetryAt = Number((db.database.prepare(`
      SELECT completion_next_attempt_at_ms FROM countdowns WHERE id = 'countdown-1'
    `).get() as { completion_next_attempt_at_ms: number }).completion_next_attempt_at_ms);
    expect(firstRetryAt).toBeGreaterThanOrEqual(631_000);
    await service.tick(firstRetryAt - 1);
    expect(channelFetch).toHaveBeenCalled();
    expect(userFetch).toHaveBeenCalledOnce();
    expect(db.getCountdown("countdown-1")?.state).toBe("completed");
    expect(db.countActive("guild-1", "creator-1", firstRetryAt - 1)).toBe(0);

    await service.tick(firstRetryAt);
    expect(userFetch).toHaveBeenCalledTimes(2);

    const secondRetryAt = Number((db.database.prepare(`
      SELECT completion_next_attempt_at_ms FROM countdowns WHERE id = 'countdown-1'
    `).get() as { completion_next_attempt_at_ms: number }).completion_next_attempt_at_ms);
    expect(secondRetryAt).toBeGreaterThanOrEqual(firstRetryAt + 60_000);
    await service.tick(secondRetryAt - 1);
    expect(userFetch).toHaveBeenCalledTimes(2);
    await service.tick(secondRetryAt);
    expect(userFetch).toHaveBeenCalledTimes(3);
  });

  it("delivers persisted completion, subscriber, and card retries after a file-backed restart", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const directory = mkdtempSync(join(tmpdir(), "countdown-bot-scheduler-restart-"));
    const path = join(directory, "countdowns.db");
    let first: CountdownDatabase | undefined;
    let reopened: CountdownDatabase | undefined;
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      first = new CountdownDatabase(path);
      first.createCountdown(countdown(), []);
      first.setSubscription("countdown-1", "subscriber-1", true, 2_000);
      const unavailableClient = {
        channels: { fetch: vi.fn().mockRejectedValue(new Error("missing access")) },
        users: { fetch: vi.fn().mockRejectedValue(new Error("DMs disabled")) },
        guilds: { fetch: vi.fn() },
      } as unknown as Client;

      await scheduler(unavailableClient, first).tick(601_000);
      const beforeRestart = first.database.prepare(`
        SELECT completion_next_attempt_at_ms, completion_attempt_count,
          card_update_next_attempt_at_ms, card_update_attempt_count
        FROM countdowns WHERE id = 'countdown-1'
      `).get() as {
        completion_next_attempt_at_ms: number;
        completion_attempt_count: number;
        card_update_next_attempt_at_ms: number;
        card_update_attempt_count: number;
      };
      const subscriberBeforeRestart = first.database.prepare(`
        SELECT next_attempt_at_ms, attempt_count
        FROM subscriber_deliveries
        WHERE countdown_id = 'countdown-1' AND user_id = 'subscriber-1' AND offset_ms = 0
      `).get() as { next_attempt_at_ms: number; attempt_count: number };
      expect(first.getCountdown("countdown-1")?.state).toBe("completed");
      expect(beforeRestart).toMatchObject({
        completion_attempt_count: 1,
        card_update_attempt_count: 1,
      });
      expect(subscriberBeforeRestart.attempt_count).toBe(1);

      first.close();
      first = undefined;
      reopened = new CountdownDatabase(path);

      expect(reopened.database.prepare(`
        SELECT completion_next_attempt_at_ms, completion_attempt_count,
          card_update_next_attempt_at_ms, card_update_attempt_count
        FROM countdowns WHERE id = 'countdown-1'
      `).get()).toEqual(beforeRestart);
      expect(reopened.database.prepare(`
        SELECT next_attempt_at_ms, attempt_count
        FROM subscriber_deliveries
        WHERE countdown_id = 'countdown-1' AND user_id = 'subscriber-1' AND offset_ms = 0
      `).get()).toEqual(subscriberBeforeRestart);

      const channelSend = vi.fn().mockResolvedValue({});
      const messageEdit = vi.fn().mockResolvedValue({});
      const subscriberSend = vi.fn().mockResolvedValue({});
      const recoveredClient = {
        channels: { fetch: vi.fn().mockResolvedValue({
          isTextBased: () => true,
          send: channelSend,
          messages: { edit: (_id: string, payload: any) => messageEdit(payload), fetch: vi.fn().mockResolvedValue({ edit: messageEdit }) },
        }) },
        users: { fetch: vi.fn().mockResolvedValue({ send: subscriberSend }) },
        guilds: { fetch: vi.fn() },
      } as unknown as Client;
      const retryTimes = [
        beforeRestart.completion_next_attempt_at_ms,
        beforeRestart.card_update_next_attempt_at_ms,
        subscriberBeforeRestart.next_attempt_at_ms,
      ];
      const earliestRetryAt = Math.min(...retryTimes);
      const latestRetryAt = Math.max(...retryTimes);
      const recoveredScheduler = scheduler(recoveredClient, reopened);

      await recoveredScheduler.tick(earliestRetryAt - 1);
      expect(channelSend).not.toHaveBeenCalled();
      expect(subscriberSend).not.toHaveBeenCalled();
      expect(messageEdit).not.toHaveBeenCalled();

      await recoveredScheduler.tick(latestRetryAt);
      expect(channelSend).toHaveBeenCalledOnce();
      expect(channelSend).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining("Time's up"),
        enforceNonce: true,
      }));
      expect(subscriberSend).toHaveBeenCalledOnce();
      expect(subscriberSend).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining("Time's up"),
        enforceNonce: true,
      }));
      expect(messageEdit).toHaveBeenCalledOnce();
      const card = messageEdit.mock.calls[0]?.[0] as { embeds?: Array<{ toJSON(): any }> };
      const fields = card.embeds?.[0]?.toJSON().fields as Array<{ name: string; value: string }>;
      expect(fields.find(({ name }) => name === "Status")?.value).toBe("Time's up");
      expect(reopened.database.prepare(`
        SELECT completion_sent_at_ms, card_updated_at_ms
        FROM countdowns WHERE id = 'countdown-1'
      `).get()).toMatchObject({
        completion_sent_at_ms: expect.any(Number),
        card_updated_at_ms: expect.any(Number),
      });
      expect(reopened.database.prepare(`
        SELECT sent_at_ms FROM subscriber_deliveries
        WHERE countdown_id = 'countdown-1' AND user_id = 'subscriber-1' AND offset_ms = 0
      `).get()).toMatchObject({ sent_at_ms: expect.any(Number) });
    } finally {
      first?.close();
      reopened?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("lets only one scheduler instance claim and send the same completion", async () => {
    const db = database();
    db.createCountdown(countdown(), []);
    const channelSend = vi.fn().mockResolvedValue({});
    const client = {
      channels: { fetch: vi.fn().mockResolvedValue({
        isTextBased: () => true,
        send: channelSend,
        messages: { edit: vi.fn().mockRejectedValue(new Error("deleted")), fetch: vi.fn().mockRejectedValue(new Error("deleted")) },
      }) },
      users: { fetch: vi.fn() },
      guilds: { fetch: vi.fn() },
    } as unknown as Client;
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await Promise.all([
      scheduler(client, db).tick(601_000),
      scheduler(client, db).tick(601_000),
    ]);

    expect(channelSend).toHaveBeenCalledOnce();
    expect(db.getCountdown("countdown-1")?.state).toBe("completed");
  });

  it("renews a slow delivery claim so another scheduler cannot duplicate the message", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(601_000);
    try {
      const db = database();
      db.createCountdown(countdown(), []);
      let releaseSend: () => void = () => undefined;
      const blockedSend = new Promise<void>((resolve) => {
        releaseSend = resolve;
      });
      const firstSend = vi.fn(async () => blockedSend);
      const secondSend = vi.fn().mockResolvedValue({});
      const channel = (send: typeof firstSend | typeof secondSend) => ({
        isTextBased: () => true,
        send,
        messages: { edit: vi.fn().mockResolvedValue({}), fetch: vi.fn().mockResolvedValue({ edit: vi.fn().mockResolvedValue({}) }) },
      });
      const firstClient = {
        channels: { fetch: vi.fn().mockResolvedValue(channel(firstSend)) },
        users: { fetch: vi.fn() },
        guilds: { fetch: vi.fn() },
      } as unknown as Client;
      const secondClient = {
        channels: { fetch: vi.fn().mockResolvedValue(channel(secondSend)) },
        users: { fetch: vi.fn() },
        guilds: { fetch: vi.fn() },
      } as unknown as Client;

      const firstTick = scheduler(firstClient, db).tick(601_000);
      for (let index = 0; index < 10 && firstSend.mock.calls.length === 0; index += 1) {
        await Promise.resolve();
      }
      expect(firstSend).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(121_000);
      await scheduler(secondClient, db).tick(722_000);
      expect(secondSend).not.toHaveBeenCalled();

      releaseSend();
      await firstTick;
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses Discord's enforced nonce to deduplicate a post-acceptance crash retry", async () => {
    const db = database();
    db.createCountdown(countdown(), []);
    db.finalizeDueCountdowns(601_000);
    expect(db.claimCompletion("countdown-1", 601_000)?.id).toBe("countdown-1");

    const nonce = deliveryNonce("channel", "completion", "countdown-1");
    const acceptedNonces = new Set([nonce]);
    let acceptedMessages = 1;
    const channelSend = vi.fn().mockImplementation(async (payload: {
      nonce?: string | number;
      enforceNonce?: boolean;
    }) => {
      if (!payload.enforceNonce || !payload.nonce || !acceptedNonces.has(String(payload.nonce))) {
        acceptedMessages += 1;
        if (payload.nonce) acceptedNonces.add(String(payload.nonce));
      }
      return {};
    });
    const client = {
      channels: { fetch: vi.fn().mockResolvedValue({
        isTextBased: () => true,
        send: channelSend,
        messages: { edit: vi.fn().mockResolvedValue({}), fetch: vi.fn().mockResolvedValue({ edit: vi.fn().mockResolvedValue({}) }) },
      }) },
      users: { fetch: vi.fn() },
      guilds: { fetch: vi.fn() },
    } as unknown as Client;

    await scheduler(client, db).tick(722_000);

    expect(channelSend).toHaveBeenCalledWith(expect.objectContaining({ nonce, enforceNonce: true }));
    expect(acceptedMessages).toBe(1);
  });

  it("deletes a reminder that resolves after completion preempts its claim", async () => {
    const db = database();
    db.createCountdown(countdown(), [60_000]);
    let releaseReminder: (message: { delete(): Promise<void> }) => void = () => undefined;
    const blockedReminder = new Promise<{ delete(): Promise<void> }>((resolve) => {
      releaseReminder = resolve;
    });
    const events: string[] = [];
    const staleDelete = vi.fn()
      .mockRejectedValueOnce(new Error("transient delete failure"))
      .mockImplementationOnce(async () => {
        events.push("stale-deleted");
      });
    const channelSend = vi.fn().mockImplementation(async (payload: { content?: string }) => {
      if (payload.content?.includes(" left.")) {
        events.push("reminder-submitted");
        return await blockedReminder;
      }
      events.push("completion");
      return { delete: vi.fn().mockResolvedValue(undefined) };
    });
    const channel = {
      isTextBased: () => true,
      send: channelSend,
      messages: { edit: vi.fn().mockResolvedValue({}), fetch: vi.fn().mockResolvedValue({ edit: vi.fn().mockResolvedValue({}) }) },
    };
    const client = {
      channels: { fetch: vi.fn().mockResolvedValue(channel) },
      users: { fetch: vi.fn() },
      guilds: { fetch: vi.fn() },
    } as unknown as Client;
    const reminderScheduler = scheduler(client, db);
    const completionScheduler = scheduler(client, db);

    const reminderTick = reminderScheduler.tick(541_000);
    for (let index = 0; index < 10 && channelSend.mock.calls.length === 0; index += 1) {
      await Promise.resolve();
    }
    expect(events).toEqual(["reminder-submitted"]);

    await completionScheduler.tick(601_000);
    expect(events).toEqual(["reminder-submitted", "completion"]);
    releaseReminder({ delete: staleDelete });
    await reminderTick;

    expect(staleDelete).toHaveBeenCalledTimes(2);
    expect(events).toEqual(["reminder-submitted", "completion", "stale-deleted"]);
    expect(db.getCountdown("countdown-1")?.state).toBe("completed");
  });

  it("persists cleanup when every immediate stale-message delete fails and retries on a later tick", async () => {
    const db = database();
    db.createCountdown(countdown(), [60_000]);
    let releaseReminder: (message: {
      id: string;
      channelId: string;
      delete(): Promise<void>;
    }) => void = () => undefined;
    const blockedReminder = new Promise<{
      id: string;
      channelId: string;
      delete(): Promise<void>;
    }>((resolve) => { releaseReminder = resolve; });
    const immediateDelete = vi.fn().mockRejectedValue(new Error("Discord unavailable"));
    const persistedDelete = vi.fn().mockResolvedValue(undefined);
    const channelSend = vi.fn().mockImplementation(async (payload: { content?: string }) =>
      payload.content?.includes(" left.") ? await blockedReminder : {});
    const messageFetch = vi.fn().mockImplementation(async (messageId: string) =>
      messageId === "stale-reminder"
        ? { delete: persistedDelete }
        : { edit: vi.fn().mockResolvedValue({}) });
    const channel = {
      isTextBased: () => true,
      send: channelSend,
      messages: { edit: vi.fn().mockResolvedValue({}), fetch: messageFetch },
    };
    const client = {
      channels: { fetch: vi.fn().mockResolvedValue(channel) },
      users: { fetch: vi.fn() },
      guilds: { fetch: vi.fn() },
    } as unknown as Client;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reminderScheduler = scheduler(client, db);
    const completionScheduler = scheduler(client, db);

    const reminderTick = reminderScheduler.tick(541_000);
    for (let index = 0; index < 10 && channelSend.mock.calls.length === 0; index += 1) await Promise.resolve();
    await completionScheduler.tick(601_000);
    releaseReminder({
      id: "stale-reminder",
      channelId: "channel-1",
      delete: immediateDelete,
    });
    await reminderTick;

    expect(immediateDelete).toHaveBeenCalledTimes(3);
    expect(db.getPendingMessageDeletionIds(570_999)).toEqual([]);
    expect(db.getPendingMessageDeletionIds(571_000)).toEqual(["stale-reminder"]);
    await reminderScheduler.tick(571_000);
    expect(persistedDelete).toHaveBeenCalledOnce();
    expect(db.getPendingMessageDeletionIds(600_000)).toEqual([]);
  });

  it("marks a milestone sent after creator fallback and still alerts subscribers", async () => {
    const db = database();
    db.createCountdown(countdown(), [60_000]);
    db.toggleSubscription("countdown-1", "subscriber-1", 2_000);
    const creatorSend = vi.fn().mockResolvedValue({});
    const subscriberSend = vi.fn().mockResolvedValue({});
    const userFetch = vi.fn().mockImplementation(async (userId: string) => ({
      send: userId === "creator-1" ? creatorSend : subscriberSend,
    }));
    const client = {
      channels: { fetch: vi.fn().mockRejectedValue(new Error("missing access")) },
      users: { fetch: userFetch },
      guilds: { fetch: vi.fn() },
    } as unknown as Client;
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await scheduler(client, db).tick(541_000);
    expect(creatorSend).toHaveBeenCalledOnce();
    expect(subscriberSend).toHaveBeenCalledOnce();
    expect(db.getDueReminders(550_000)).toEqual([]);
  });

  it("collapses missed milestones into one accurate reminder after downtime", async () => {
    const db = database();
    const endsAtMs = 7_201_000;
    db.createCountdown(countdown({ durationMs: 7_200_000, remainingMs: 7_200_000, endsAtMs }), [
      3_600_000,
      600_000,
      60_000,
    ]);
    const channelSend = vi.fn().mockResolvedValue({});
    const client = {
      channels: { fetch: vi.fn().mockResolvedValue({ isTextBased: () => true, send: channelSend }) },
      users: { fetch: vi.fn() },
      guilds: { fetch: vi.fn() },
    } as unknown as Client;

    await scheduler(client, db).tick(endsAtMs - 500_000);
    expect(channelSend).toHaveBeenCalledOnce();
    expect(channelSend.mock.calls[0]?.[0].content).toContain("8 minutes 20 seconds left");
    expect(db.getDueReminders(endsAtMs - 500_000)).toEqual([]);

    await scheduler(client, db).tick(endsAtMs - 60_000);
    expect(channelSend).toHaveBeenCalledTimes(2);
  });

  it("does not repeat a milestone when only a subscriber received it", async () => {
    const db = database();
    db.createCountdown(countdown(), [60_000]);
    db.toggleSubscription("countdown-1", "subscriber-1", 2_000);
    const subscriberSend = vi.fn().mockResolvedValue({});
    const client = {
      channels: { fetch: vi.fn().mockRejectedValue(new Error("missing access")) },
      users: { fetch: vi.fn().mockImplementation(async (userId: string) => {
        if (userId === "creator-1") throw new Error("creator DMs disabled");
        return { send: subscriberSend };
      }) },
      guilds: { fetch: vi.fn() },
    } as unknown as Client;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const service = scheduler(client, db);

    await service.tick(541_000);
    await service.tick(571_000);
    expect(subscriberSend).toHaveBeenCalledOnce();
    expect(db.getDueReminders(571_000)).toEqual([]);
  });

  it("DMs a subscribed creator when the channel milestone succeeds", async () => {
    const db = database();
    db.createCountdown(countdown(), [60_000]);
    db.toggleSubscription("countdown-1", "creator-1", 2_000);
    const channelSend = vi.fn().mockResolvedValue({});
    const creatorSend = vi.fn().mockResolvedValue({});
    const client = {
      channels: { fetch: vi.fn().mockResolvedValue({ isTextBased: () => true, send: channelSend }) },
      users: { fetch: vi.fn().mockResolvedValue({ send: creatorSend }) },
      guilds: { fetch: vi.fn() },
    } as unknown as Client;

    await scheduler(client, db).tick(541_000);
    expect(channelSend).toHaveBeenCalledOnce();
    expect(creatorSend).toHaveBeenCalledOnce();
  });

  it("completes when a subscriber is the only reachable recipient", async () => {
    const db = database();
    db.createCountdown(countdown(), []);
    db.toggleSubscription("countdown-1", "subscriber-1", 2_000);
    const subscriberSend = vi.fn().mockResolvedValue({});
    const client = {
      channels: { fetch: vi.fn().mockRejectedValue(new Error("missing access")) },
      users: { fetch: vi.fn().mockImplementation(async (userId: string) => {
        if (userId === "creator-1") throw new Error("creator DMs disabled");
        return { send: subscriberSend };
      }) },
      guilds: { fetch: vi.fn() },
    } as unknown as Client;
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await scheduler(client, db).tick(601_000);
    expect(subscriberSend).toHaveBeenCalledOnce();
    expect(db.getCountdown("countdown-1")?.state).toBe("completed");
  });

  it("stops retrying a permanently undeliverable completion after 24 hours", async () => {
    const db = database();
    db.createCountdown(countdown({ messageId: null }), []);
    const client = {
      channels: { fetch: vi.fn().mockRejectedValue(new Error("missing access")) },
      users: { fetch: vi.fn().mockRejectedValue(new Error("DMs disabled")) },
      guilds: { fetch: vi.fn() },
    } as unknown as Client;
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await scheduler(client, db).tick(601_000 + 86_400_000);
    expect(db.getCountdown("countdown-1")?.state).toBe("completed");
    expect(client.channels.fetch).not.toHaveBeenCalled();
    expect(client.users.fetch).not.toHaveBeenCalled();
  });

  it("queues the selected voice alert even when every text destination fails", async () => {
    const db = database();
    db.createCountdown(countdown({ sound: "beep", voiceChannelId: "voice-1" }), []);
    const played: string[] = [];
    const voiceQueue = new VoiceAlertQueue(async (_guild, channelId, sound) => {
      played.push(`${channelId}:${sound}`);
    }, () => 601_000);
    const client = {
      channels: { fetch: vi.fn().mockRejectedValue(new Error("missing channel")) },
      users: { fetch: vi.fn().mockRejectedValue(new Error("DMs disabled")) },
      guilds: { fetch: vi.fn().mockResolvedValue({ id: "guild-1" }) },
    } as unknown as Client;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const service = new CountdownScheduler(client, db, { siteBaseUrl: "https://onlinealarmkur.com" }, voiceQueue);

    await service.tick(601_000);
    await service.drain();
    expect(played).toEqual(["voice-1:beep"]);
    expect(db.getCountdown("countdown-1")?.state).toBe("completed");
  });

  it("backs off a voice claim when the guild lookup fails and later retries", async () => {
    const db = database();
    db.createCountdown(countdown({ sound: "beep", voiceChannelId: "voice-1" }), []);
    const played: string[] = [];
    const voiceQueue = new VoiceAlertQueue(async (_guild, channelId, sound) => {
      played.push(`${channelId}:${sound}`);
    }, () => 602_000);
    const guildFetch = vi.fn()
      .mockRejectedValueOnce(new Error("temporary Discord failure"))
      .mockResolvedValue({ id: "guild-1" });
    const client = {
      channels: { fetch: vi.fn().mockResolvedValue({
        isTextBased: () => true,
        send: vi.fn().mockResolvedValue({}),
        messages: { edit: vi.fn().mockRejectedValue(new Error("deleted")), fetch: vi.fn().mockRejectedValue(new Error("deleted")) },
      }) },
      users: { fetch: vi.fn() },
      guilds: { fetch: guildFetch },
    } as unknown as Client;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const service = new CountdownScheduler(client, db, { siteBaseUrl: "https://onlinealarmkur.com" }, voiceQueue);

    await service.tick(601_000);
    await service.drain();
    expect(played).toEqual([]);

    await service.tick(632_000);
    await service.drain();
    expect(guildFetch).toHaveBeenCalledTimes(2);
    expect(played).toEqual(["voice-1:beep"]);
  });

  it("retries a voice alert after playback itself fails", async () => {
    const db = database();
    db.createCountdown(countdown({ sound: "beep", voiceChannelId: "voice-1" }), []);
    let nowMs = 601_000;
    const runner = vi.fn()
      .mockRejectedValueOnce(new Error("temporary voice disconnect"))
      .mockResolvedValue(undefined);
    const voiceQueue = new VoiceAlertQueue(runner, () => nowMs, () => undefined);
    const client = {
      channels: { fetch: vi.fn().mockResolvedValue({
        isTextBased: () => true,
        send: vi.fn().mockResolvedValue({}),
        messages: { edit: vi.fn().mockResolvedValue({}), fetch: vi.fn().mockResolvedValue({ edit: vi.fn().mockResolvedValue({}) }) },
      }) },
      users: { fetch: vi.fn() },
      guilds: { fetch: vi.fn().mockResolvedValue({ id: "guild-1" }) },
    } as unknown as Client;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const service = new CountdownScheduler(client, db, { siteBaseUrl: "https://onlinealarmkur.com" }, voiceQueue);

    await service.tick(nowMs);
    await service.drain();
    expect(runner).toHaveBeenCalledOnce();

    nowMs += 31_000;
    await service.tick(nowMs);
    await service.drain();
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("recovers a crashed voice claim while the alert is still useful", async () => {
    const db = database();
    db.createCountdown(countdown({ sound: "bell", voiceChannelId: "voice-1" }), []);
    db.finalizeDueCountdowns(601_000);
    expect(db.claimNextVoiceAlert(601_000)?.id).toBe("countdown-1");
    const restartAtMs = 722_000;
    const runner = vi.fn().mockResolvedValue(undefined);
    const voiceQueue = new VoiceAlertQueue(runner, () => restartAtMs);
    const client = {
      channels: { fetch: vi.fn().mockResolvedValue({
        isTextBased: () => true,
        send: vi.fn().mockResolvedValue({}),
        messages: { edit: vi.fn().mockResolvedValue({}), fetch: vi.fn().mockResolvedValue({ edit: vi.fn().mockResolvedValue({}) }) },
      }) },
      users: { fetch: vi.fn() },
      guilds: { fetch: vi.fn().mockResolvedValue({ id: "guild-1" }) },
    } as unknown as Client;
    const service = new CountdownScheduler(client, db, { siteBaseUrl: "https://onlinealarmkur.com" }, voiceQueue);

    await service.tick(restartAtMs);
    await service.drain();
    expect(runner).toHaveBeenCalledOnce();
  });

  it("does not let a slow voice connection delay unrelated text alerts", async () => {
    const db = database();
    db.createCountdown(countdown({ sound: "urgent", voiceChannelId: "voice-1" }), []);
    db.createCountdown(countdown({
      id: "countdown-2",
      messageId: "message-2",
      creatorId: "creator-2",
      endsAtMs: 601_000,
    }), []);
    let releaseVoice: () => void = () => undefined;
    const voiceBlocked = new Promise<void>((resolve) => {
      releaseVoice = resolve;
    });
    const voiceQueue = new VoiceAlertQueue(async () => voiceBlocked, () => 601_000);
    const channelSend = vi.fn().mockResolvedValue({});
    const client = {
      channels: { fetch: vi.fn().mockResolvedValue({
        isTextBased: () => true,
        send: channelSend,
        messages: { edit: vi.fn().mockRejectedValue(new Error("deleted")), fetch: vi.fn().mockRejectedValue(new Error("deleted")) },
      }) },
      users: { fetch: vi.fn() },
      guilds: { fetch: vi.fn().mockResolvedValue({ id: "guild-1" }) },
    } as unknown as Client;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const service = new CountdownScheduler(client, db, { siteBaseUrl: "https://onlinealarmkur.com" }, voiceQueue);

    await service.tick(601_000);
    expect(channelSend).toHaveBeenCalledTimes(2);
    releaseVoice();
    await service.drain();
  });

  it("retries only the subscriber whose completion DM failed", async () => {
    const db = database();
    db.createCountdown(countdown(), []);
    db.setSubscription("countdown-1", "subscriber-ok", true, 2_000);
    db.setSubscription("countdown-1", "subscriber-retry", true, 2_001);
    const sends = new Map<string, number>();
    const channelSend = vi.fn().mockResolvedValue({});
    const client = {
      channels: { fetch: vi.fn().mockResolvedValue({
        isTextBased: () => true,
        send: channelSend,
        messages: { edit: vi.fn().mockRejectedValue(new Error("deleted")), fetch: vi.fn().mockRejectedValue(new Error("deleted")) },
      }) },
      users: { fetch: vi.fn().mockImplementation(async (userId: string) => ({
        send: async () => {
          const attempts = (sends.get(userId) ?? 0) + 1;
          sends.set(userId, attempts);
          if (userId === "subscriber-retry" && attempts === 1) throw new Error("temporary DM error");
        },
      })) },
      guilds: { fetch: vi.fn() },
    } as unknown as Client;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const service = scheduler(client, db);

    await service.tick(601_000);
    expect(sends.get("subscriber-ok")).toBe(1);
    expect(sends.get("subscriber-retry")).toBe(1);

    await service.tick(630_999);
    expect(sends.get("subscriber-retry")).toBe(1);
    await service.tick(632_000);
    expect(sends.get("subscriber-ok")).toBe(1);
    expect(sends.get("subscriber-retry")).toBe(2);
  });

  it("expires an overdue voice alert before making a guild request", async () => {
    const db = database();
    db.createCountdown(countdown({ sound: "beep", voiceChannelId: "voice-1" }), []);
    const guildFetch = vi.fn();
    const client = {
      channels: { fetch: vi.fn().mockResolvedValue({
        isTextBased: () => true,
        send: vi.fn().mockResolvedValue({}),
        messages: { edit: vi.fn().mockResolvedValue({}), fetch: vi.fn().mockResolvedValue({ edit: vi.fn().mockResolvedValue({}) }) },
      }) },
      users: { fetch: vi.fn() },
      guilds: { fetch: guildFetch },
    } as unknown as Client;
    const service = scheduler(client, db);

    await service.tick(901_001);
    await service.drain();
    expect(guildFetch).not.toHaveBeenCalled();
    expect(db.claimNextVoiceAlert(901_002)).toBeNull();
  });

  it("caps pre-queue voice work while guild lookups are stalled", async () => {
    const db = database();
    for (let index = 0; index < 60; index += 1) {
      db.createCountdown(countdown({
        id: `countdown-${index}`,
        messageId: `message-${index}`,
        sound: "beep",
        voiceChannelId: `voice-${index}`,
      }), []);
    }
    let releaseGuilds: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseGuilds = resolve;
    });
    const guildFetch = vi.fn(async () => {
      await blocked;
      return { id: "guild-1" };
    });
    const client = {
      channels: { fetch: vi.fn().mockResolvedValue({
        isTextBased: () => true,
        send: vi.fn().mockResolvedValue({}),
        messages: { edit: vi.fn().mockResolvedValue({}), fetch: vi.fn().mockResolvedValue({ edit: vi.fn().mockResolvedValue({}) }) },
      }) },
      users: { fetch: vi.fn() },
      guilds: { fetch: guildFetch },
    } as unknown as Client;
    const voiceQueue = new VoiceAlertQueue(async () => undefined, () => 601_000);
    const service = new CountdownScheduler(client, db, { siteBaseUrl: "https://onlinealarmkur.com" }, voiceQueue);

    await service.tick(601_000);
    expect(guildFetch).toHaveBeenCalledTimes(25);
    releaseGuilds();
    await service.drain();
  });

  it("continues retrying subscriber completion DMs beyond eight attempts within the 24-hour window", async () => {
    const db = database();
    db.createCountdown(countdown(), []);
    db.setSubscription("countdown-1", "subscriber-retry", true, 2_000);
    const send = vi.fn().mockRejectedValue(new Error("DMs temporarily unavailable"));
    const client = {
      channels: { fetch: vi.fn().mockResolvedValue({
        isTextBased: () => true,
        send: vi.fn().mockResolvedValue({}),
        messages: { edit: vi.fn().mockResolvedValue({}), fetch: vi.fn().mockResolvedValue({ edit: vi.fn().mockResolvedValue({}) }) },
      }) },
      users: { fetch: vi.fn().mockResolvedValue({ send }) },
      guilds: { fetch: vi.fn() },
    } as unknown as Client;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const service = scheduler(client, db);
    let tickAtMs = 601_000;

    for (let attempt = 1; attempt <= 9; attempt += 1) {
      await service.tick(tickAtMs);
      expect(send).toHaveBeenCalledTimes(attempt);
      const row = db.database.prepare(`
        SELECT next_attempt_at_ms, abandoned_at_ms FROM subscriber_deliveries
        WHERE countdown_id = 'countdown-1' AND user_id = 'subscriber-retry' AND offset_ms = 0
      `).get() as { next_attempt_at_ms: number; abandoned_at_ms: number | null };
      expect(row.abandoned_at_ms).toBeNull();
      tickAtMs = Number(row.next_attempt_at_ms);
    }
  });

  it("also DMs the creator when a role alert succeeds in the channel", async () => {
    const db = database();
    db.createCountdown(countdown({ mention: "<@&role-1>" }), []);
    const creatorSend = vi.fn().mockResolvedValue({});
    const channelSend = vi.fn().mockResolvedValue({});
    const client = {
      channels: { fetch: vi.fn().mockResolvedValue({
        isTextBased: () => true,
        send: channelSend,
        messages: { edit: vi.fn().mockResolvedValue({}), fetch: vi.fn().mockResolvedValue({ edit: vi.fn().mockResolvedValue({}) }) },
      }) },
      users: { fetch: vi.fn().mockResolvedValue({ send: creatorSend }) },
      guilds: { fetch: vi.fn() },
    } as unknown as Client;

    await scheduler(client, db).tick(601_000);
    expect(channelSend).toHaveBeenCalledOnce();
    expect(creatorSend).toHaveBeenCalledOnce();
  });

  it("persists and retries a failed role-alert creator completion DM with the same nonce", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const db = database();
    db.createCountdown(countdown({ mention: "<@&role-1>" }), []);
    db.setSubscription("countdown-1", "creator-1", true, 2_000);
    const nonces: string[] = [];
    const creatorSend = vi.fn().mockImplementation(async (payload: { nonce: string }) => {
      nonces.push(payload.nonce);
      if (nonces.length === 1) throw new Error("response lost after acceptance");
      return {};
    });
    const channelSend = vi.fn().mockResolvedValue({});
    const client = {
      channels: { fetch: vi.fn().mockResolvedValue({
        isTextBased: () => true,
        send: channelSend,
        messages: { edit: vi.fn().mockResolvedValue({}), fetch: vi.fn().mockResolvedValue({ edit: vi.fn().mockResolvedValue({}) }) },
      }) },
      users: { fetch: vi.fn().mockResolvedValue({ send: creatorSend }) },
      guilds: { fetch: vi.fn() },
    } as unknown as Client;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const service = scheduler(client, db);

    await service.tick(601_000);
    expect(creatorSend).toHaveBeenCalledOnce();
    await service.tick(630_999);
    expect(creatorSend).toHaveBeenCalledOnce();
    await service.tick(632_000);
    expect(creatorSend).toHaveBeenCalledTimes(2);
    expect(new Set(nonces).size).toBe(1);
    expect(channelSend).toHaveBeenCalledOnce();
  });

  it("persists and retries a failed role-alert creator milestone DM", async () => {
    const db = database();
    db.createCountdown(countdown({ mention: "<@&role-1>" }), [60_000]);
    const creatorSend = vi.fn()
      .mockRejectedValueOnce(new Error("temporary DM failure"))
      .mockResolvedValue({});
    const channelSend = vi.fn().mockResolvedValue({});
    const client = {
      channels: { fetch: vi.fn().mockResolvedValue({
        isTextBased: () => true,
        send: channelSend,
        messages: { edit: vi.fn().mockResolvedValue({}), fetch: vi.fn() },
      }) },
      users: { fetch: vi.fn().mockResolvedValue({ send: creatorSend }) },
      guilds: { fetch: vi.fn() },
    } as unknown as Client;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const service = scheduler(client, db);

    await service.tick(541_000);
    expect(creatorSend).toHaveBeenCalledOnce();
    await service.tick(572_000);
    expect(creatorSend).toHaveBeenCalledTimes(2);
    expect(channelSend).toHaveBeenCalledOnce();
  });

  it("recovers a completion lease that moved into the future after a clock rollback", async () => {
    const db = database();
    db.createCountdown(countdown(), []);
    db.finalizeDueCountdowns(601_000);
    expect(db.claimCompletion("countdown-1", 1_000_000)?.id).toBe("countdown-1");
    const channelSend = vi.fn().mockResolvedValue({});
    const client = {
      channels: { fetch: vi.fn().mockResolvedValue({
        isTextBased: () => true,
        send: channelSend,
        messages: { edit: vi.fn().mockResolvedValue({}), fetch: vi.fn().mockResolvedValue({ edit: vi.fn().mockResolvedValue({}) }) },
      }) },
      users: { fetch: vi.fn() },
      guilds: { fetch: vi.fn() },
    } as unknown as Client;
    const service = scheduler(client, db);

    await service.tick(500_000);
    expect(channelSend).not.toHaveBeenCalled();
    await service.tick(601_000);
    expect(channelSend).toHaveBeenCalledOnce();
  });
});
