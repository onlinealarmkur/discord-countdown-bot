import { ChannelType, PermissionFlagsBits, PermissionsBitField, Client } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CountdownDatabase } from "../src/database.js";
import { createCountdownVisibilityCheck } from "../src/discord/countdown-access.js";
import { installInteractionHandlers } from "../src/discord/handlers.js";
import { CountdownScheduler } from "../src/services/scheduler.js";
import { countdown } from "./fixtures.js";

const openDatabases: CountdownDatabase[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(2_000);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  openDatabases.splice(0).forEach((db) => db.close());
});

function database(): CountdownDatabase {
  const db = new CountdownDatabase(":memory:");
  openDatabases.push(db);
  db.createCountdown(countdown(), []);
  db.setSubscription("countdown-1", "subscriber-1", true, 2_000);
  return db;
}

function discord() {
  let permissions = [PermissionFlagsBits.ViewChannel];
  const member = { id: "subscriber-1" };
  const permissionsFor = vi.fn(() => new PermissionsBitField(permissions));
  const threadMemberFetch = vi.fn().mockResolvedValue({ id: "subscriber-1" });
  const channel = {
    id: "channel-1",
    guildId: "guild-1",
    type: ChannelType.GuildText,
    parentId: "parent-1" as string | null,
    isThread: () => channel.type === ChannelType.PrivateThread || channel.type === ChannelType.PublicThread,
    permissionsFor,
    members: { fetch: threadMemberFetch },
    isTextBased: () => true,
    send: vi.fn().mockResolvedValue({}),
    messages: { edit: vi.fn().mockResolvedValue({}) },
  };
  const parent = { guildId: "guild-1", permissionsFor };
  const memberFetch = vi.fn().mockResolvedValue(member);
  const channelFetch = vi.fn().mockImplementation(async (id: string) => id === "parent-1" ? parent : channel);
  const guild = { members: { fetch: memberFetch }, channels: { fetch: channelFetch } };
  const dmSend = vi.fn().mockResolvedValue({});
  const client = {
    guilds: { fetch: vi.fn().mockResolvedValue(guild) },
    channels: { fetch: vi.fn().mockResolvedValue(channel), cache: new Map() },
    users: { fetch: vi.fn().mockResolvedValue({ send: dmSend }) },
    on: vi.fn(),
    off: vi.fn(),
  };
  return {
    client: client as unknown as Client,
    raw: client,
    channel, parent, member, memberFetch, channelFetch, threadMemberFetch, dmSend,
    permissions: (value: bigint[]) => { permissions = value; },
    visible: () => createCountdownVisibilityCheck(client as unknown as Client, "guild-1", "subscriber-1")("channel-1"),
  };
}

describe("fresh subscriber visibility", () => {
  it("fetches fresh member roles and channel overwrites, deduplicated only within one request", async () => {
    const api = discord();
    const check = createCountdownVisibilityCheck(api.client, "guild-1", "subscriber-1");
    expect(await Promise.all([check("channel-1"), check("channel-1")])).toEqual([true, true]);
    expect(api.memberFetch).toHaveBeenCalledExactlyOnceWith({ user: "subscriber-1", force: true, cache: false });
    expect(api.raw.guilds.fetch).toHaveBeenCalledExactlyOnceWith({ guild: "guild-1", force: true });
    expect(api.channelFetch).toHaveBeenCalledExactlyOnceWith("channel-1", { force: true });
    expect(api.channel.permissionsFor).toHaveBeenCalledWith(api.member);
    api.permissions([]);
    expect(await api.visible()).toBe(false);
    expect(api.memberFetch).toHaveBeenCalledTimes(2);
  });

  it.each(["member", "channel", "guild"])("fails closed when the %s lookup fails", async (lookup) => {
    const api = discord();
    const fetch = lookup === "member" ? api.memberFetch : lookup === "channel" ? api.channelFetch : api.raw.guilds.fetch;
    fetch.mockRejectedValue(new Error("unavailable"));
    expect(await api.visible()).toBe(false);
  });

  it.each(["missing", "wrong-guild", "no-view"])("rejects a %s channel", async (reason) => {
    const api = discord();
    if (reason === "missing") api.channelFetch.mockResolvedValue(null);
    if (reason === "wrong-guild") api.channel.guildId = "other-guild";
    if (reason === "no-view") api.permissions([]);
    expect(await api.visible()).toBe(false);
  });

  it("requires current private-thread membership and fresh parent permissions", async () => {
    const api = discord();
    api.channel.type = ChannelType.PrivateThread;
    expect(await api.visible()).toBe(true);
    expect(api.channelFetch).toHaveBeenCalledWith("parent-1", { force: true });
    expect(api.threadMemberFetch).toHaveBeenCalledWith({ member: "subscriber-1", force: true, cache: false });
    api.threadMemberFetch.mockRejectedValue(new Error("removed from thread"));
    expect(await api.visible()).toBe(false);
  });

  it.each(["missing-parent", "hidden-parent", "wrong-guild-parent"])("rejects a thread with %s", async (reason) => {
    const api = discord();
    api.channel.type = ChannelType.PrivateThread;
    if (reason === "missing-parent") api.channel.parentId = null;
    if (reason === "hidden-parent") api.permissions([]);
    if (reason === "wrong-guild-parent") api.parent.guildId = "other-guild";
    expect(await api.visible()).toBe(false);
    expect(api.threadMemberFetch).not.toHaveBeenCalled();
  });

  it("allows thread managers with View Channel without a thread membership lookup", async () => {
    const api = discord();
    api.channel.type = ChannelType.PrivateThread;
    api.permissions([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageThreads]);
    expect(await api.visible()).toBe(true);
    expect(api.threadMemberFetch).not.toHaveBeenCalled();
    api.permissions([PermissionFlagsBits.ManageThreads]);
    expect(await api.visible()).toBe(false);
  });

  it("uses current parent visibility for public threads without requiring membership", async () => {
    const api = discord();
    api.channel.type = ChannelType.PublicThread;
    expect(await api.visible()).toBe(true);
    expect(api.threadMemberFetch).not.toHaveBeenCalled();
  });
});

describe("Discord SDK cache behavior", () => {
  it.each(["channel-overwrite", "parent-overwrite", "member-role", "role-permissions", "guild-ownership"])("uses the REST response after revoking %s despite cached access", async (revocation) => {
    const client = new Client({ intents: [] });
    const guildId = "100000000000000001";
    const userId = "100000000000000002";
    const channelId = "100000000000000003";
    const parentId = "100000000000000004";
    const roleId = "100000000000000005";
    const privateThread = revocation === "parent-overwrite";
    const role = (id: string, permissions: bigint) => ({
      id, name: id, permissions: String(permissions), position: 0, color: 0,
      hoist: false, managed: false, mentionable: false, flags: 0,
    });
    const channelData = (id: string) => ({
      id, guild_id: guildId, type: ChannelType.GuildText, name: "test",
      permission_overwrites: [] as Array<{ id: string; type: number; allow: string; deny: string }>,
    });
    const parent = channelData(parentId);
    const channel = {
      ...channelData(channelId),
      ...(privateThread ? {
        type: ChannelType.PrivateThread, parent_id: parentId, owner_id: userId,
        thread_metadata: { archived: false, locked: false, auto_archive_duration: 60, archive_timestamp: "2026-01-01T00:00:00Z" },
      } : {}),
    };
    const member = { user: { id: userId, username: "subscriber" }, roles: [roleId], joined_at: "2026-01-01T00:00:00Z" };
    const guildData = {
      id: guildId, name: "Test", owner_id: revocation === "guild-ownership" ? userId : "100000000000000099",
      roles: [role(guildId, 0n), role(roleId, revocation === "guild-ownership" ? 0n : PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ManageMessages)],
    };
    const responses: Record<string, unknown> = {
      [`/guilds/${guildId}`]: guildData,
      [`/guilds/${guildId}/members/${userId}`]: member,
      [`/channels/${channelId}`]: channel,
      [`/channels/${parentId}`]: parent,
      [`/channels/${channelId}/thread-members/${userId}`]: { id: channelId, user_id: userId, flags: 0, join_timestamp: "2026-01-01T00:00:00Z" },
    };
    // Real SDK managers and permission calculations; only the REST transport is
    // stubbed. No login, credentials or network requests are involved.
    vi.spyOn(client.rest, "get").mockImplementation(async (route) => {
      if (!(route in responses)) throw new Error(`Unexpected fixture route: ${route}`);
      return structuredClone(responses[route]);
    });
    try {
      const guild = await client.guilds.fetch(guildId);
      const cachedMember = await guild.members.fetch(userId);
      const cachedChannel = await guild.channels.fetch(channelId);
      if (privateThread) await guild.channels.fetch(parentId);
      expect(cachedChannel?.permissionsFor(cachedMember)?.has(PermissionFlagsBits.ViewChannel)).toBe(true);
      expect(await createCountdownVisibilityCheck(client, guildId, userId)(channelId)).toBe(true);

      if (revocation === "member-role") member.roles = [];
      else if (revocation === "role-permissions") guildData.roles[1]!.permissions = "0";
      else if (revocation === "guild-ownership") guildData.owner_id = "100000000000000099";
      else (privateThread ? parent : channel).permission_overwrites = [{
        id: userId, type: 1, allow: "0", deny: String(PermissionFlagsBits.ViewChannel),
      }];
      expect(await createCountdownVisibilityCheck(client, guildId, userId)(channelId)).toBe(false);
      const db = new CountdownDatabase(":memory:");
      openDatabases.push(db);
      db.createCountdown(countdown({ guildId, channelId }), []);
      db.setSubscription("countdown-1", userId, true, 2_000);
      let listener!: (interaction: unknown) => Promise<void>;
      vi.spyOn(client, "on").mockImplementation((_event, callback) => {
        listener = callback as typeof listener;
        return client;
      });
      const controller = installInteractionHandlers(client, db, { siteBaseUrl: "https://example.test", defaultTimezone: "UTC" });
      const respond = vi.fn().mockResolvedValue(undefined);
      await listener({
        commandName: "countdown-manage", guildId, client, user: { id: userId },
        memberPermissions: new PermissionsBitField(),
        options: { getFocused: () => ({ name: "countdown", value: "" }) },
        isAutocomplete: () => true, respond,
      });
      controller.stop();
      expect(respond).toHaveBeenCalledWith([]);
      if (!cachedChannel?.isTextBased() || !("send" in cachedChannel)) throw new Error("Expected a text fixture channel");
      vi.spyOn(cachedChannel, "send").mockResolvedValue({} as never);
      vi.spyOn(cachedChannel.messages, "edit").mockResolvedValue({} as never);
      const dmSend = vi.spyOn(client.users.cache.get(userId)!, "send").mockResolvedValue({} as never);
      await new CountdownScheduler(client, db, { siteBaseUrl: "https://example.test" }).tick(601_000);
      expect(dmSend).not.toHaveBeenCalled();
    } finally {
      await client.destroy();
    }
  });
});

describe("subscriber delivery authorization", () => {
  it("suppresses a revoked subscriber DM, retains the subscription, and delivers once after restored access", async () => {
    const db = database();
    const api = discord();
    api.permissions([]);
    const scheduler = new CountdownScheduler(api.client, db, { siteBaseUrl: "https://example.test" });
    await scheduler.tick(601_000);
    expect(api.channel.send).toHaveBeenCalledOnce();
    expect(api.dmSend).not.toHaveBeenCalled();
    expect(db.isSubscribed("countdown-1", "subscriber-1")).toBe(true);
    api.permissions([PermissionFlagsBits.ViewChannel]);
    await scheduler.tick(632_000);
    await scheduler.tick(700_000);
    expect(api.dmSend).toHaveBeenCalledOnce();
  });

  it("does not disclose a changed deadline to a removed private-thread member", async () => {
    const db = database();
    // The owner changes the deadline after the subscriber loses access.
    db.database.prepare("UPDATE countdowns SET ends_at_ms = ? WHERE id = ?").run(901_000, "countdown-1");
    const api = discord();
    api.channel.type = ChannelType.PrivateThread;
    api.threadMemberFetch.mockRejectedValue(new Error("removed"));
    await new CountdownScheduler(api.client, db, { siteBaseUrl: "https://example.test" }).tick(901_000);
    expect(api.dmSend).not.toHaveBeenCalled();
    expect(db.isSubscribed("countdown-1", "subscriber-1")).toBe(true);
  });

  it("retains a subscription after transient authorization lookup failure", async () => {
    const db = database();
    const api = discord();
    api.memberFetch.mockRejectedValueOnce(new Error("temporary REST failure"));
    const scheduler = new CountdownScheduler(api.client, db, { siteBaseUrl: "https://example.test" });
    await scheduler.tick(601_000);
    expect(api.dmSend).not.toHaveBeenCalled();
    expect(db.isSubscribed("countdown-1", "subscriber-1")).toBe(true);
    await scheduler.tick(632_000);
    expect(api.dmSend).toHaveBeenCalledOnce();
  });

  it("rechecks the delivery claim after an unsubscribe during the permission lookup", async () => {
    const db = database();
    const api = discord();
    api.memberFetch.mockImplementation(async () => {
      db.setSubscription("countdown-1", "subscriber-1", false, 601_000);
      return api.member;
    });
    await new CountdownScheduler(api.client, db, { siteBaseUrl: "https://example.test" }).tick(601_000);
    expect(api.dmSend).not.toHaveBeenCalled();
    expect(db.isSubscribed("countdown-1", "subscriber-1")).toBe(false);
  });

  it("preserves creator fallback when the original channel has disappeared", async () => {
    const db = database();
    db.setSubscription("countdown-1", "subscriber-1", false, 2_000);
    const api = discord();
    api.raw.channels.fetch.mockRejectedValue(Object.assign(new Error("deleted"), { code: 10003 }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await new CountdownScheduler(api.client, db, { siteBaseUrl: "https://example.test" }).tick(601_000);
    expect(api.raw.users.fetch).toHaveBeenCalledWith("creator-1");
    expect(api.dmSend).toHaveBeenCalledOnce();
    expect(api.raw.guilds.fetch).not.toHaveBeenCalled();
  });
});

describe("subscribed management autocomplete", () => {
  async function autocomplete(api: ReturnType<typeof discord>, db: CountdownDatabase) {
    let listener: ((interaction: unknown) => Promise<void>) | undefined;
    api.raw.on.mockImplementation((_event, callback) => { listener = callback; });
    const controller = installInteractionHandlers(api.client, db, { siteBaseUrl: "https://example.test", defaultTimezone: "UTC" });
    const respond = vi.fn().mockResolvedValue(undefined);
    const work = listener!({
      commandName: "countdown-manage", guildId: "guild-1", client: api.client,
      user: { id: "subscriber-1" }, memberPermissions: new PermissionsBitField(),
      options: { getFocused: () => ({ name: "countdown", value: "" }) },
      isAutocomplete: () => true, isChatInputCommand: () => false, isButton: () => false,
      isStringSelectMenu: () => false, isModalSubmit: () => false, isRepliable: () => false, respond,
    });
    await work;
    controller.stop();
    return respond;
  }

  it("hides subscribed countdowns after visibility is lost and shows them after it is restored", async () => {
    const db = database();
    const api = discord();
    api.permissions([]);
    expect(await autocomplete(api, db)).toHaveBeenCalledWith([]);
    api.permissions([PermissionFlagsBits.ViewChannel]);
    expect(await autocomplete(api, db)).toHaveBeenCalledWith([{ name: "Launch night • countdow", value: "countdown-1" }]);
  });

  it("deduplicates lookups and fails closed within the response budget", async () => {
    vi.useFakeTimers();
    const db = database();
    db.createCountdown(countdown({ id: "countdown-2" }), []);
    db.setSubscription("countdown-2", "subscriber-1", true, 2_000);
    const api = discord();
    api.memberFetch.mockReturnValue(new Promise(() => {}));
    const result = autocomplete(api, db);
    await vi.advanceTimersByTimeAsync(2_001);
    expect(await result).toHaveBeenCalledWith([]);
    expect(api.memberFetch).toHaveBeenCalledOnce();
  });

  it("never overrides a failed fresh subscriber check with cached moderator permissions", async () => {
    vi.useFakeTimers();
    const db = database();
    const api = discord();
    api.channel.type = ChannelType.PrivateThread;
    api.permissions([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageMessages]);
    api.raw.channels.cache.set("channel-1", api.channel);
    api.memberFetch.mockImplementation(() => new Promise((_, reject) => {
      setTimeout(() => reject(new Error("permission lookup unavailable")), 1_500);
    }));
    api.threadMemberFetch.mockReturnValue(new Promise(() => {}));
    let finished = false;
    const result = autocomplete(api, db).then((respond) => { finished = true; return respond; });
    await vi.advanceTimersByTimeAsync(1_501);
    expect(api.threadMemberFetch).not.toHaveBeenCalled();
    expect(finished).toBe(true);
    expect(await result).toHaveBeenCalledWith([]);
  });
});
