import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { CountdownDatabase } from "../src/database.js";
import { installInteractionHandlers } from "../src/discord/handlers.js";
import { CountdownScheduler } from "../src/services/scheduler.js";
import { countdown } from "./fixtures.js";

function creationHarness(db: CountdownDatabase, countdownLimits?: { perGuild: number; total: number; perUser: number; creationsPerMinute: number }) {
  let listener: ((interaction: unknown) => Promise<void>) | undefined;
  const client = { on: (_: string, next: typeof listener) => { listener = next; }, off: vi.fn() } as unknown as Client;
  const controller = installInteractionHandlers(client, db, {
    siteBaseUrl: "https://onlinealarmkur.com", defaultTimezone: "UTC",
    ...(countdownLimits ? { countdownLimits } : {}),
  });
  const interaction = {
    commandName: "countdown", guildId: "guild-1", channelId: "channel-1", user: { id: "qa-user" },
    client, member: null, guild: { members: { me: null } }, appPermissions: null, memberPermissions: null,
    channel: { isThread: () => false }, deferred: false, replied: false,
    options: { getString: (name: string) => name === "when" ? "5m" : null, getRole: () => null },
    isAutocomplete: () => false, isChatInputCommand: () => true, isButton: () => false,
    isStringSelectMenu: () => false, isModalSubmit: () => false, isRepliable: () => true,
    reply: vi.fn(async (_payload: unknown) => undefined), followUp: vi.fn(async () => undefined),
    deferReply: vi.fn(async () => { interaction.deferred = true; }),
    fetchReply: vi.fn(async () => ({ id: "new-message", edit: vi.fn(async () => undefined) })),
    editReply: vi.fn(async () => undefined),
  };
  return { interaction, run: async () => { await listener!(interaction); }, controller };
}

describe("configured countdown capacity", () => {
  it("accepts the 101st countdown in a server under the provisional 5000 default", async () => {
    const db = new CountdownDatabase(":memory:");
    try {
      for (let index = 0; index < 100; index += 1) db.createCountdown(countdown({
        id: `seed-${index}`, messageId: `seed-message-${index}`, creatorId: `other-${index}`,
        createdAtMs: Date.now() - 120_000, endsAtMs: Date.now() + 86_400_000,
      }), []);
      const app = creationHarness(db);
      await app.run();
      expect(app.interaction.reply).not.toHaveBeenCalled();
      expect(app.interaction.editReply).toHaveBeenCalled();
      expect(db.countActive("guild-1", undefined)).toBe(101);
      app.controller.stop();
    } finally { db.close(); }
  });

  it.each(["guild", "user", "rate", "global"] as const)("enforces the configured %s safeguard", async (guard) => {
    const db = new CountdownDatabase(":memory:");
    try {
      const count = guard === "guild" || guard === "global" ? 2 : 1;
      for (let index = 0; index < count; index += 1) db.createCountdown(countdown({
        id: `seed-${index}`, messageId: `message-${index}`,
        guildId: guard === "global" ? "another-guild" : "guild-1",
        creatorId: guard === "guild" || guard === "global" ? `other-${index}` : "qa-user",
        state: guard === "rate" ? "cancelled" : "running",
        createdAtMs: guard === "rate" ? Date.now() : Date.now() - 120_000,
        endsAtMs: Date.now() + 86_400_000,
      }), []);
      const app = creationHarness(db, { perGuild: 2, total: 2, perUser: 1, creationsPerMinute: 1 });
      await app.run();
      const content = app.interaction.reply.mock.calls[0]?.[0] as unknown as { content: string };
      expect(content.content).toContain(guard === "guild" ? "server can have up to 2" : guard === "user" ? "You can have up to 1" : guard === "global" ? "bot is at its active countdown limit" : "Create at most 1");
      expect(app.interaction.deferReply).not.toHaveBeenCalled();
      app.controller.stop();
    } finally { db.close(); }
  });
});

describe("a burst of 1000 text countdowns", () => {
  it("finishes and delivers each once using bounded workers on a file-backed SQLite database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "countdown-capacity-"));
    const db = new CountdownDatabase(join(directory, "countdowns.db"));
    const serviceClient = {
      channels: { fetch: vi.fn() }, users: { fetch: vi.fn() }, guilds: { fetch: vi.fn() },
    };
    let inFlight = 0; let peak = 0;
    const nonces = new Set<string>();
    const send = vi.fn(async (payload: { nonce: string }) => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      expect(nonces.has(payload.nonce)).toBe(false);
      nonces.add(payload.nonce);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return {};
    });
    const edit = vi.fn(async () => undefined);
    serviceClient.channels.fetch.mockResolvedValue({
      isTextBased: () => true, send, messages: { edit, fetch: vi.fn(async () => { throw Error("Card fetch is unnecessary"); }) },
    });
    const scheduler = new CountdownScheduler(serviceClient as unknown as Client, db, { siteBaseUrl: "https://onlinealarmkur.com" });
    try {
      for (let index = 0; index < 1000; index += 1) db.createCountdown(countdown({
        id: `countdown-${index}`, messageId: `message-${index}`, creatorId: `creator-${index}`,
      }), []);
      for (let tick = 0; tick < 25; tick += 1) await scheduler.tick(601_000 + tick * 1000);
      await scheduler.tick(631_000);
      expect(db.countActive("guild-1", undefined, 631_000)).toBe(0);
      expect(db.getPendingCompletions(631_000, 2000)).toHaveLength(0);
      expect(send).toHaveBeenCalledTimes(1000);
      expect(edit).toHaveBeenCalledTimes(1000);
      const channel = await serviceClient.channels.fetch.mock.results[0]?.value;
      expect(channel.messages.fetch).not.toHaveBeenCalled();
      expect(nonces.size).toBe(1000);
      expect(peak).toBeLessThanOrEqual(10);
    } finally {
      scheduler.stop(); await scheduler.drain(); db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
