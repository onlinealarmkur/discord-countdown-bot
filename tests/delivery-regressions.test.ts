import type { Client } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CountdownDatabase } from "../src/database.js";
import { CountdownScheduler } from "../src/services/reliable-scheduler.js";
import { countdown } from "./fixtures.js";

afterEach(() => vi.restoreAllMocks());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function app(db: CountdownDatabase, send: (payload: any) => Promise<unknown>) {
  const channel = { isTextBased: () => true, send,
    messages: { edit: vi.fn().mockResolvedValue({}), fetch: vi.fn().mockResolvedValue({ edit: vi.fn().mockResolvedValue({}) }) } };
  const client = { channels: { fetch: vi.fn().mockResolvedValue(channel) },
    users: { fetch: vi.fn() }, guilds: { fetch: vi.fn() } } as unknown as Client;
  return { service: new CountdownScheduler(client, db, { siteBaseUrl: "https://example.test" }), client };
}

describe("independent deadline processing", () => {
  it("delivers a later countdown while an unrelated completion send remains stalled", async () => {
    const db = new CountdownDatabase(":memory:");
    const hold = deferred();
    const entered = deferred();
    const send = vi.fn(async (payload: { content: string }) => {
      if (payload.content.includes("First")) { entered.resolve(); await hold.promise; }
      return {};
    });
    const { service } = app(db, send);
    try {
      db.createCountdown(countdown({ title: "First", endsAtMs: 541_000 }), []);
      db.createCountdown(countdown({ id: "second", messageId: "message-2", title: "Second" }), [60_000]);
      const first = service.tick(541_000);
      await entered.promise;
      await service.tick(611_000);
      expect(db.getCountdown("second")?.state).toBe("completed");
      expect(send.mock.calls.map(([payload]) => payload.content)).toEqual([
        expect.stringContaining("Time's up: First"), expect.stringContaining("Time's up: Second"),
      ]);
      hold.resolve();
      await first;
      expect(send.mock.calls.every(([payload]) => !payload.content.includes("left"))).toBe(true);
    } finally {
      hold.resolve();
      await service.drain();
      db.close();
    }
  });

  it("does not send a stale milestone after its channel lookup crosses expiry", async () => {
    const db = new CountdownDatabase(":memory:");
    const hold = deferred();
    const entered = deferred();
    let wall = 0;
    vi.spyOn(Date, "now").mockImplementation(() => wall);
    const send = vi.fn().mockResolvedValue({});
    const { service, client } = app(db, send);
    const fetch = vi.mocked(client.channels.fetch);
    fetch.mockImplementationOnce(async () => {
      entered.resolve(); await hold.promise;
      return { isTextBased: () => true, send } as never;
    });
    try {
      db.createCountdown(countdown(), [60_000]);
      const first = service.tick(541_000);
      await entered.promise;
      wall = 70_000;
      hold.resolve();
      await first;
      expect(send).not.toHaveBeenCalled();
      await service.tick(611_000);
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0]?.[0].content).toContain("Time's up");
    } finally {
      hold.resolve(); await service.drain(); db.close();
    }
  });

  it("keeps overlapping text delivery bounded and drains all in-flight work", async () => {
    const db = new CountdownDatabase(":memory:");
    const hold = deferred();
    const send = vi.fn(async () => { await hold.promise; return {}; });
    const { service } = app(db, send);
    try {
      for (let index = 0; index < 30; index += 1) {
        db.createCountdown(countdown({ id: `c-${index}`, messageId: `m-${index}` }), []);
      }
      const first = service.tick(601_000);
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(10));
      await service.tick(602_000);
      await service.tick(603_000);
      expect(send).toHaveBeenCalledTimes(10);
      let drained = false;
      const drain = service.drain().then(() => { drained = true; });
      await Promise.resolve();
      expect(drained).toBe(false);
      hold.resolve();
      await first; await drain;
      expect(send).toHaveBeenCalledTimes(30);
    } finally {
      hold.resolve(); await service.drain(); db.close();
    }
  });
});

describe("durable subscriber bookkeeping", () => {
  it("keeps subscribers who join between a failed milestone and a later milestone", () => {
    const db = new CountdownDatabase(":memory:");
    try {
      db.createCountdown(countdown(), [300_000, 60_000]);
      db.setSubscription("countdown-1", "early", true, 2_000);
      const first = db.claimReminderDelivery("countdown-1", 301_000)!;
      db.retryReminderDelivery("countdown-1", [300_000], first.claimAtMs, 331_000, null);
      db.setSubscription("countdown-1", "late", true, 361_000);
      const retry = db.claimReminderDelivery("countdown-1", 571_000)!;
      db.finishReminderDelivery("countdown-1", [300_000], retry.claimAtMs, 571_000);
      const batch = db.claimSubscriberBatch("countdown-1", 571_000)!;
      expect(batch.groups.map(({ userId }) => userId)).toEqual(["early", "late"]);
      for (const group of batch.groups) {
        db.finishSubscriberDelivery("countdown-1", group.userId, group.offsets, batch.claimAtMs, 571_000);
      }
      db.releaseSubscriberBatch("countdown-1", batch.claimAtMs);
      expect(db.getDueSubscriberCountdownIds(572_000)).toEqual([]);
    } finally { db.close(); }
  });

  it("does not repeat catch-up for a subscriber already notified after the later milestone became due", () => {
    const db = new CountdownDatabase(":memory:");
    try {
      db.createCountdown(countdown(), [300_000, 60_000]);
      db.setSubscription("countdown-1", "early", true, 2_000);
      const first = db.claimReminderDelivery("countdown-1", 301_000)!;
      db.retryReminderDelivery("countdown-1", [300_000], first.claimAtMs, 331_000, null);
      const batch = db.claimSubscriberBatch("countdown-1", 560_000)!;
      db.finishSubscriberDelivery("countdown-1", "early", [300_000], batch.claimAtMs, 560_000);
      db.releaseSubscriberBatch("countdown-1", batch.claimAtMs);
      const retry = db.claimReminderDelivery("countdown-1", 571_000)!;
      db.finishReminderDelivery("countdown-1", [300_000], retry.claimAtMs, 571_000);
      expect(db.getDueSubscriberCountdownIds(572_000)).toEqual([]);
    } finally { db.close(); }
  });

  it.each([
    [50_007, 1],
    [500, 2],
  ])("stops retrying a subscriber DM only for permanent errors (code %i)", async (code, attempts) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = new CountdownDatabase(":memory:");
    const dm = vi.fn().mockRejectedValue(Object.assign(new Error("DM failed"), { code }));
    const { service, client } = app(db, vi.fn(async (_payload: { content: string }) => ({})));
    vi.mocked(client.users.fetch).mockResolvedValue({ send: dm } as never);
    try {
      db.createCountdown(countdown(), []);
      db.setSubscription("countdown-1", "subscriber-1", true, 2_000);
      await service.tick(601_000);
      await service.drain();
      await service.tick(1_201_000);
      await service.drain();
      expect(dm).toHaveBeenCalledTimes(attempts);
    } finally { await service.drain(); db.close(); }
  });

  it("abandons a completion whose channel denies access and whose creator has DMs closed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = new CountdownDatabase(":memory:");
    const send = vi.fn().mockRejectedValue(Object.assign(new Error("Missing Permissions"), { code: 50_013 }));
    const dm = vi.fn().mockRejectedValue(Object.assign(new Error("Cannot send messages to this user"), { code: 50_007 }));
    const { service, client } = app(db, send);
    vi.mocked(client.users.fetch).mockResolvedValue({ send: dm } as never);
    try {
      db.createCountdown(countdown(), []);
      await service.tick(601_000);
      await service.drain();
      expect(send).toHaveBeenCalledTimes(1);
      expect(dm).toHaveBeenCalledTimes(1);
      expect(db.getPendingCompletions(3_601_000)).toEqual([]);
      await service.tick(3_601_000);
      await service.drain();
      expect(send).toHaveBeenCalledTimes(1);
    } finally { await service.drain(); db.close(); }
  });

  it("keeps retrying a completion after a transient channel error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = new CountdownDatabase(":memory:");
    const send = vi.fn().mockRejectedValueOnce(Object.assign(new Error("Server error"), { status: 500 }))
      .mockResolvedValue({});
    const dm = vi.fn().mockRejectedValue(Object.assign(new Error("Cannot send messages to this user"), { code: 50_007 }));
    const { service, client } = app(db, send);
    vi.mocked(client.users.fetch).mockResolvedValue({ send: dm } as never);
    try {
      db.createCountdown(countdown(), []);
      await service.tick(601_000);
      await service.drain();
      expect(db.getPendingCompletions(3_601_000)).toHaveLength(1);
      await service.tick(3_601_000);
      await service.drain();
      expect(send).toHaveBeenCalledTimes(2);
      expect(db.getPendingCompletions(3_601_000)).toEqual([]);
    } finally { await service.drain(); db.close(); }
  });

  it("drops a subscriber whose DMs are closed, so later milestones skip them", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = new CountdownDatabase(":memory:");
    const dm = vi.fn().mockRejectedValue(Object.assign(new Error("Cannot send messages to this user"), { code: 50_007 }));
    const { service, client } = app(db, vi.fn(async (_payload: { content: string }) => ({})));
    vi.mocked(client.users.fetch).mockResolvedValue({ send: dm } as never);
    try {
      db.createCountdown(countdown({ endsAtMs: 3_001_000 }), [2_400_000, 600_000]);
      db.setSubscription("countdown-1", "subscriber-1", true, 2_000);
      await service.tick(601_000);
      await service.drain();
      expect(dm).toHaveBeenCalledTimes(1);
      expect(db.isSubscribed("countdown-1", "subscriber-1")).toBe(false);
      await service.tick(2_401_000);
      await service.drain();
      expect(dm).toHaveBeenCalledTimes(1);
    } finally { await service.drain(); db.close(); }
  });

  it("follows a backward system-clock step instead of firing later deadlines early", async () => {
    const db = new CountdownDatabase(":memory:");
    const send = vi.fn(async (_payload: { content: string }) => ({}));
    const { service } = app(db, send);
    try {
      await service.tick(1_000_000);
      db.createCountdown(countdown({ startedAtMs: 390_000, endsAtMs: 990_000 }), []);
      // The host clock steps back 60 seconds; the deadline is 30 seconds away.
      await service.tick(960_000);
      expect(db.getCountdown("countdown-1")?.state).toBe("running");
      expect(send).not.toHaveBeenCalled();
      await service.tick(991_000);
      expect(db.getCountdown("countdown-1")?.state).toBe("completed");
    } finally { await service.drain(); db.close(); }
  });

  it("still posts Time's up to the channel when the creator's subscriber DM finished first", async () => {
    const db = new CountdownDatabase(":memory:");
    const send = vi.fn(async (_payload: { content: string }) => ({}));
    const { service, client } = app(db, send);
    try {
      db.createCountdown(countdown(), []);
      db.setSubscription("countdown-1", "creator-1", true, 2_000);
      db.finalizeDueCountdowns(601_000);
      // Overlapping ticks let the subscriber pool DM the creator before the
      // completion pool reaches this countdown.
      db.markSubscriberOffsetsDelivered("countdown-1", "creator-1", [0], 601_500);
      await service.tick(602_000);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[0].content).toContain("Time's up: Launch night");
      expect(client.users.fetch).not.toHaveBeenCalled();
      expect(db.getPendingCompletions(603_000)).toEqual([]);
    } finally { await service.drain(); db.close(); }
  });

  it.each(["completion", "milestone"])("honors a persisted creator %s DM on a later primary retry", async (kind) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = new CountdownDatabase(":memory:");
    const send = vi.fn().mockRejectedValueOnce(new Error("temporary failure")).mockResolvedValue({});
    const client = { channels: { fetch: vi.fn().mockResolvedValue(null) },
      users: { fetch: vi.fn().mockResolvedValue({ send }) }, guilds: { fetch: vi.fn() } } as unknown as Client;
    const service = new CountdownScheduler(client, db, { siteBaseUrl: "https://example.test" });
    try {
      const endsAtMs = kind === "completion" ? 601_000 : 3_001_000;
      const offset = kind === "completion" ? 0 : 2_400_000;
      db.createCountdown(countdown({ endsAtMs }), offset ? [offset] : []);
      db.setSubscription("countdown-1", "creator-1", true, 2_000);
      await service.tick(601_000);
      expect(send).toHaveBeenCalledTimes(2);
      expect(db.hasSuccessfulSubscriberDelivery("countdown-1", "creator-1", [offset])).toBe(true);
      // A fresh scheduler, ten minutes later: beyond Discord's short nonce cache.
      const restarted = new CountdownScheduler(client, db, { siteBaseUrl: "https://example.test" });
      await restarted.tick(1_201_000);
      expect(send).toHaveBeenCalledTimes(2);
      expect(kind === "completion" ? db.getPendingCompletions(1_201_000) : db.getDueReminders(1_201_000)).toEqual([]);
    } finally { await service.drain(); db.close(); }
  });
});
