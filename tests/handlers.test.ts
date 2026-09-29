import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
  type Client,
  type GuildMember,
  type VoiceBasedChannel,
} from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { CountdownDatabase } from "../src/database.js";
import {
  chunkDiscordLines,
  hasCountdownChannelPermission,
  installInteractionHandlers,
  resolveVoiceAlert,
  truncateDiscordText,
} from "../src/discord/handlers.js";
import { countdown } from "./fixtures.js";

describe("Discord response boundaries", () => {
  it("splits a worst-case countdown list below Discord's content limit", () => {
    const lines = Array.from({ length: 20 }, (_, index) =>
      `• [${"\\*".repeat(100)}](https://discord.com/channels/${"9".repeat(20)}/${"8".repeat(20)}/${"7".repeat(20)}) · <t:9999999999:R> ${index}`,
    );
    const chunks = chunkDiscordLines(lines);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 1_900)).toBe(true);
    expect(chunks.join("\n").split("\n")).toEqual(lines);
  });

  it("keeps a short list in one reply", () => {
    expect(chunkDiscordLines(["one", "two"])).toEqual(["one\ntwo"]);
  });

  it("rejects an impossible single entry instead of sending an invalid reply", () => {
    expect(() => chunkDiscordLines(["x".repeat(1_901)])).toThrow();
  });

  it("truncates emoji-heavy autocomplete names by serialized length without splitting Unicode", () => {
    const value = truncateDiscordText("🚀".repeat(70), 89);
    expect(value.length).toBeLessThanOrEqual(89);
    expect(value.length).toBe(88);
    expect(Array.from(value)).toHaveLength(44);
    expect(Array.from(value).every((character) => character === "🚀")).toBe(true);
  });

  it("rejects invalid text limits", () => {
    expect(() => truncateDiscordText("text", -1)).toThrow(RangeError);
    expect(() => truncateDiscordText("text", Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });
});

describe("interaction handler shutdown", () => {
  it("stops accepting new interactions before draining work already in flight", async () => {
    let listener: ((interaction: unknown) => Promise<void> | void) | undefined;
    let releaseFirst: () => void = () => undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const off = vi.fn();
    const client = {
      on: vi.fn((_event: string, value: (interaction: unknown) => Promise<void> | void) => {
        listener = value;
      }),
      off,
    } as unknown as Client;
    const db = new CountdownDatabase(":memory:");
    try {
      const controller = installInteractionHandlers(client, db, {
        siteBaseUrl: "https://onlinealarmkur.com",
        defaultTimezone: "UTC",
      });
      const interaction = (respond: () => Promise<void>) => ({
        commandName: "countdown",
        options: { getFocused: () => ({ name: "when", value: "5m" }) },
        isAutocomplete: () => true,
        isChatInputCommand: () => false,
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        isRepliable: () => false,
        respond,
      });
      const firstRespond = vi.fn(async () => firstBlocked);
      const secondRespond = vi.fn(async () => undefined);

      const firstJob = listener?.(interaction(firstRespond));
      await Promise.resolve();
      expect(firstRespond).toHaveBeenCalledOnce();

      controller.stop();
      expect(off).toHaveBeenCalledWith("interactionCreate", listener);
      await listener?.(interaction(secondRespond));
      expect(secondRespond).not.toHaveBeenCalled();

      let drained = false;
      const draining = controller.drain().then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);
      releaseFirst();
      await firstJob;
      await draining;
      expect(drained).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe("stored countdown channel authorization", () => {
  const channel = (permissions: bigint[]) => ({
    permissionsFor: () => new PermissionsBitField(permissions),
  });

  it("requires visibility in the stored channel", () => {
    expect(hasCountdownChannelPermission(channel([]), "user-1")).toBe(false);
    expect(hasCountdownChannelPermission(
      channel([PermissionFlagsBits.ViewChannel]),
      "user-1",
    )).toBe(true);
  });

  it("requires both View Channel and Manage Messages for moderator control", () => {
    expect(hasCountdownChannelPermission(
      channel([PermissionFlagsBits.ManageMessages]),
      "user-1",
      PermissionFlagsBits.ManageMessages,
    )).toBe(false);
    expect(hasCountdownChannelPermission(
      channel([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageMessages]),
      "user-1",
      PermissionFlagsBits.ManageMessages,
    )).toBe(true);
  });

  it("fails closed for missing or malformed channels", () => {
    expect(hasCountdownChannelPermission(null, "user-1")).toBe(false);
    expect(hasCountdownChannelPermission({}, "user-1", PermissionFlagsBits.ManageMessages)).toBe(false);
    expect(hasCountdownChannelPermission({ permissionsFor: () => { throw new Error("deleted"); } }, "user-1"))
      .toBe(false);
  });

  it("never trusts cached private-thread membership without a fresh check", () => {
    const privateThread = (member: boolean, manageThreads = false) => ({
      type: ChannelType.PrivateThread,
      permissionsFor: () => new PermissionsBitField([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ManageMessages,
        ...(manageThreads ? [PermissionFlagsBits.ManageThreads] : []),
      ]),
      members: { cache: new Map(member ? [["user-1", {}]] : []) },
    });
    expect(hasCountdownChannelPermission(
      privateThread(false),
      "user-1",
      PermissionFlagsBits.ManageMessages,
    )).toBe(false);
    expect(hasCountdownChannelPermission(
      privateThread(true),
      "user-1",
      PermissionFlagsBits.ManageMessages,
    )).toBe(false);
    expect(hasCountdownChannelPermission(
      privateThread(false, true),
      "user-1",
      PermissionFlagsBits.ManageMessages,
    )).toBe(true);
  });
});

describe("interaction-level channel privacy", () => {
  type Listener = (interaction: unknown) => Promise<void>;

  function clientWithListener(channelFetch: (channelId: string) => Promise<unknown>): {
    client: Client;
    listener: () => Listener;
  } {
    let captured: Listener | undefined;
    const client = {
      channels: { cache: new Map(), fetch: channelFetch },
      on: (_event: string, listener: Listener) => {
        captured = listener;
      },
    } as unknown as Client;
    return {
      client,
      listener: () => {
        if (!captured) throw new Error("Expected the interaction listener to be installed.");
        return captured;
      },
    };
  }

  function commandInteraction(
    client: Client,
    commandName: "countdown-manage" | "countdowns",
    values: Record<string, string>,
  ) {
    const interaction = {
      commandName,
      guildId: "guild-1",
      user: { id: "moderator-1" },
      client,
      deferred: false,
      replied: false,
      memberPermissions: new PermissionsBitField([PermissionFlagsBits.ManageMessages]),
      options: {
        getString: (name: string) => values[name] ?? null,
      },
      isAutocomplete: () => false,
      isChatInputCommand: () => true,
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      isRepliable: () => true,
      deferReply: vi.fn(async () => {
        interaction.deferred = true;
      }),
      editReply: vi.fn(async (_payload: unknown) => undefined),
      reply: vi.fn(async (_payload: unknown) => undefined),
      followUp: vi.fn(async (_payload: unknown) => undefined),
    };
    return interaction;
  }

  it("does not let source-channel permissions control another channel's countdown", async () => {
    const db = new CountdownDatabase(":memory:");
    try {
      db.createCountdown(countdown({ creatorId: "creator-1", channelId: "protected" }), []);
      const events: string[] = [];
      const channel = {
        permissionsFor: () => new PermissionsBitField([PermissionFlagsBits.ViewChannel]),
        isTextBased: () => true,
        messages: { fetch: vi.fn() },
      };
      const harness = clientWithListener(async () => {
        events.push("fetch");
        return channel;
      });
      installInteractionHandlers(harness.client, db, {
        siteBaseUrl: "https://onlinealarmkur.com",
        defaultTimezone: "UTC",
      });
      const interaction = commandInteraction(harness.client, "countdown-manage", {
        countdown: "countdown-1",
        action: "cancel",
      });
      interaction.deferReply.mockImplementationOnce(async () => {
        events.push("defer");
        interaction.deferred = true;
      });

      await harness.listener()(interaction);

      expect(events).toEqual(["defer", "fetch"]);
      expect(db.getCountdown("countdown-1")?.state).toBe("running");
      expect(interaction.editReply).toHaveBeenCalledWith({
        content: "Only the countdown creator or a moderator can manage it.",
      });
      expect(interaction.reply).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("does not let a private-thread non-member control its countdown", async () => {
    const db = new CountdownDatabase(":memory:");
    try {
      db.createCountdown(countdown({ creatorId: "creator-1", channelId: "private-thread" }), []);
      const harness = clientWithListener(async () => ({
        type: ChannelType.PrivateThread,
        permissionsFor: () => new PermissionsBitField([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ManageMessages,
        ]),
        members: {
          cache: new Map(),
          fetch: vi.fn().mockRejectedValue(new Error("Unknown Thread Member")),
        },
        isTextBased: () => true,
        messages: { fetch: vi.fn() },
      }));
      installInteractionHandlers(harness.client, db, {
        siteBaseUrl: "https://onlinealarmkur.com",
        defaultTimezone: "UTC",
      });
      const interaction = commandInteraction(harness.client, "countdown-manage", {
        countdown: "countdown-1",
        action: "cancel",
      });

      await harness.listener()(interaction);

      expect(db.getCountdown("countdown-1")?.state).toBe("running");
      expect(interaction.editReply).toHaveBeenCalledWith({
        content: "Only the countdown creator or a moderator can manage it.",
      });
    } finally {
      db.close();
    }
  });

  it("revokes cached private-thread access for listing and management", async () => {
    const db = new CountdownDatabase(":memory:");
    try {
      db.createCountdown(countdown({ title: "Private audit fixture", endsAtMs: Date.now() + 600_000 }), []);
      const fetch = vi.fn().mockRejectedValue(new Error("Unknown Thread Member"));
      const channel = {
        type: ChannelType.PrivateThread,
        permissionsFor: () => new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageMessages]),
        members: { cache: new Map([["moderator-1", {}]]), fetch },
      };
      const app = clientWithListener(async () => channel);
      installInteractionHandlers(app.client, db, { siteBaseUrl: "https://example.test", defaultTimezone: "UTC" });
      const list = commandInteraction(app.client, "countdowns", { scope: "server" });
      await app.listener()(list);
      expect(list.editReply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.not.stringContaining("Private audit fixture"),
      }));
      const manage = commandInteraction(app.client, "countdown-manage", { countdown: "countdown-1", action: "cancel" });
      await app.listener()(manage);
      expect(db.getCountdown("countdown-1")?.state).toBe("running");
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenCalledWith({ member: "moderator-1", force: true, cache: false });
    } finally {
      db.close();
    }
  });

  it.each([false, true])("unsubscribes privately without channel access (subscribed=%s)", async (subscribed) => {
    const db = new CountdownDatabase(":memory:");
    try {
      db.createCountdown(countdown({ title: "Private audit fixture" }), []);
      if (subscribed) db.setSubscription("countdown-1", "moderator-1", true, 2_000);
      const fetch = vi.fn().mockResolvedValue(null);
      const app = clientWithListener(fetch);
      installInteractionHandlers(app.client, db, { siteBaseUrl: "https://example.test", defaultTimezone: "UTC" });
      const interaction = commandInteraction(app.client, "countdown-manage", {
        countdown: "countdown-1", action: "unsubscribe",
      });
      await app.listener()(interaction);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: "🔕 Your reminders for that countdown are off.", flags: MessageFlags.Ephemeral,
      }));
      expect(db.isSubscribed("countdown-1", "moderator-1")).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("allows a guild administrator to recover an orphan after its channel is deleted", async () => {
    const db = new CountdownDatabase(":memory:");
    try {
      const nowMs = Date.now();
      db.createCountdown(countdown({
        creatorId: "departed-user",
        channelId: "deleted",
        startedAtMs: nowMs,
        endsAtMs: nowMs + 600_000,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      }), []);
      const harness = clientWithListener(async () => null);
      installInteractionHandlers(harness.client, db, {
        siteBaseUrl: "https://onlinealarmkur.com",
        defaultTimezone: "UTC",
      });
      const interaction = commandInteraction(harness.client, "countdown-manage", {
        countdown: "countdown-1",
        action: "cancel",
      });
      interaction.memberPermissions = new PermissionsBitField([PermissionFlagsBits.Administrator]);

      await harness.listener()(interaction);

      expect(db.getCountdown("countdown-1")?.state).toBe("cancelled");
      expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining("Saved"),
      }));
    } finally {
      db.close();
    }
  });

  it("omits countdowns from channels the caller cannot view", async () => {
    const db = new CountdownDatabase(":memory:");
    try {
      const nowMs = Date.now();
      db.createCountdown(countdown({
        id: "visible-1",
        channelId: "visible",
        messageId: "message-visible",
        title: "Public launch",
        startedAtMs: nowMs,
        endsAtMs: nowMs + 600_000,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      }), []);
      db.createCountdown(countdown({
        id: "hidden-1",
        channelId: "hidden",
        messageId: "message-hidden",
        creatorId: "creator-2",
        title: "Confidential launch",
        startedAtMs: nowMs,
        endsAtMs: nowMs + 600_000,
        createdAtMs: nowMs + 1,
        updatedAtMs: nowMs + 1,
      }), []);
      const harness = clientWithListener(async (channelId) => ({
        permissionsFor: () => new PermissionsBitField(
          channelId === "visible" ? [PermissionFlagsBits.ViewChannel] : [],
        ),
      }));
      installInteractionHandlers(harness.client, db, {
        siteBaseUrl: "https://onlinealarmkur.com",
        defaultTimezone: "UTC",
      });
      const interaction = commandInteraction(harness.client, "countdowns", { scope: "server" });

      await harness.listener()(interaction);

      const response = interaction.editReply.mock.calls[0]?.[0] as { content?: string } | undefined;
      expect(response?.content).toContain("Public launch");
      expect(response?.content).not.toContain("Confidential launch");
      expect(response?.content).not.toContain("message-hidden");
    } finally {
      db.close();
    }
  });

  it("finds older visible countdowns beyond a hidden 100-row page", async () => {
    const db = new CountdownDatabase(":memory:");
    try {
      const nowMs = Date.now();
      db.createCountdown(countdown({
        id: "older-visible", channelId: "visible", messageId: "visible-message",
        title: "Older public event", creatorId: "another-user",
        startedAtMs: nowMs, endsAtMs: nowMs + 600_000,
        createdAtMs: nowMs, updatedAtMs: nowMs,
      }), []);
      for (let index = 1; index <= 120; index += 1) {
        db.createCountdown(countdown({
          id: `hidden-${index}`, channelId: "hidden", messageId: `hidden-message-${index}`,
          title: `Confidential ${index}`, creatorId: "another-user",
          startedAtMs: nowMs, endsAtMs: nowMs + 600_000,
          createdAtMs: nowMs + index, updatedAtMs: nowMs + index,
        }), []);
      }
      const listPages = vi.spyOn(db, "listActiveAll");
      const harness = clientWithListener(async (channelId) => ({
        permissionsFor: () => new PermissionsBitField(
          channelId === "visible" ? [PermissionFlagsBits.ViewChannel] : [],
        ),
      }));
      installInteractionHandlers(harness.client, db, {
        siteBaseUrl: "https://onlinealarmkur.com", defaultTimezone: "UTC",
      });
      const interaction = commandInteraction(harness.client, "countdowns", { scope: "server" });
      await harness.listener()(interaction);
      const response = interaction.editReply.mock.calls[0]?.[0] as { content?: string } | undefined;
      expect(response?.content).toContain("Older public event");
      expect(response?.content).not.toContain("Confidential");
      expect(listPages).toHaveBeenCalledTimes(2);
      expect(listPages.mock.calls.map((call) => call[3])).toEqual([0, 100]);
    } finally {
      db.close();
    }
  });

  it("autocompletes only moderator targets manageable in their stored channel", async () => {
    const db = new CountdownDatabase(":memory:");
    try {
      const nowMs = Date.now();
      for (const [id, channelId] of [["visible-1", "visible"], ["hidden-1", "hidden"]] as const) {
        db.createCountdown(countdown({
          id,
          channelId,
          creatorId: "creator-1",
          title: channelId,
          startedAtMs: nowMs,
          endsAtMs: nowMs + 600_000,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        }), []);
      }
      const harness = clientWithListener(async () => null);
      harness.client.channels.cache.set("visible", {
        permissionsFor: () => new PermissionsBitField([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ManageMessages,
        ]),
      } as never);
      harness.client.channels.cache.set("hidden", {
        permissionsFor: () => new PermissionsBitField([PermissionFlagsBits.ViewChannel]),
      } as never);
      installInteractionHandlers(harness.client, db, {
        siteBaseUrl: "https://onlinealarmkur.com",
        defaultTimezone: "UTC",
      });
      const respond = vi.fn(async (_choices: unknown) => undefined);
      const interaction = {
        commandName: "countdown-manage",
        guildId: "guild-1",
        user: { id: "moderator-1" },
        client: harness.client,
        options: { getFocused: () => ({ name: "countdown", value: "" }) },
        isAutocomplete: () => true,
        isChatInputCommand: () => false,
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        isRepliable: () => false,
        respond,
      };

      await harness.listener()(interaction);

      const choices = respond.mock.calls[0]?.[0] as Array<{ value: string }> | undefined;
      expect(choices?.map(({ value }) => value)).toEqual(["visible-1"]);
    } finally {
      db.close();
    }
  });

  it("recovers an older countdown by a specific management search", async () => {
    const db = new CountdownDatabase(":memory:");
    try {
      const nowMs = Date.now();
      db.createCountdown(countdown({
        id: "older-project-event", channelId: "visible", messageId: "older-message",
        title: "Older project event", creatorId: "creator-1",
        startedAtMs: nowMs, endsAtMs: nowMs + 600_000,
        createdAtMs: nowMs, updatedAtMs: nowMs,
      }), []);
      for (let index = 1; index <= 120; index += 1) {
        db.createCountdown(countdown({
          id: `newer-${index}`, channelId: "hidden", messageId: `newer-message-${index}`,
          title: `Other event ${index}`, creatorId: "creator-1",
          startedAtMs: nowMs, endsAtMs: nowMs + 600_000,
          createdAtMs: nowMs + index, updatedAtMs: nowMs + index,
        }), []);
      }
      const harness = clientWithListener(async () => null);
      harness.client.channels.cache.set("visible", {
        permissionsFor: () => new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageMessages]),
      } as never);
      installInteractionHandlers(harness.client, db, {
        siteBaseUrl: "https://onlinealarmkur.com", defaultTimezone: "UTC",
      });
      const respond = vi.fn(async (_choices: unknown) => undefined);
      const interaction = {
        commandName: "countdown-manage", guildId: "guild-1", user: { id: "moderator-1" },
        client: harness.client,
        options: { getFocused: () => ({ name: "countdown", value: "older project" }) },
        isAutocomplete: () => true, isChatInputCommand: () => false,
        isButton: () => false, isStringSelectMenu: () => false,
        isModalSubmit: () => false, isRepliable: () => false, respond,
      };
      await harness.listener()(interaction);
      const choices = respond.mock.calls[0]?.[0] as Array<{ value: string }> | undefined;
      expect(choices?.map(({ value }) => value)).toEqual(["older-project-event"]);
    } finally {
      db.close();
    }
  });

  it("does not let newer hidden rows crowd an older visible countdown out of the list", async () => {
    const db = new CountdownDatabase(":memory:");
    try {
      const nowMs = Date.now();
      db.createCountdown(countdown({
        id: "visible-oldest",
        channelId: "visible",
        title: "Visible oldest",
        startedAtMs: nowMs,
        endsAtMs: nowMs + 600_000,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      }), []);
      for (let index = 1; index <= 20; index += 1) {
        db.createCountdown(countdown({
          id: `hidden-${index}`,
          channelId: `hidden-${index}`,
          creatorId: `creator-${index}`,
          title: `Hidden ${index}`,
          startedAtMs: nowMs,
          endsAtMs: nowMs + 600_000,
          createdAtMs: nowMs + index,
          updatedAtMs: nowMs + index,
        }), []);
      }
      const harness = clientWithListener(async (channelId) => ({
        permissionsFor: () => new PermissionsBitField(
          channelId === "visible" ? [PermissionFlagsBits.ViewChannel] : [],
        ),
      }));
      installInteractionHandlers(harness.client, db, {
        siteBaseUrl: "https://onlinealarmkur.com",
        defaultTimezone: "UTC",
      });
      const interaction = commandInteraction(harness.client, "countdowns", { scope: "server" });

      await harness.listener()(interaction);

      const response = interaction.editReply.mock.calls[0]?.[0] as { content?: string } | undefined;
      expect(response?.content).toContain("Visible oldest");
      expect(response?.content).not.toContain("Hidden");
    } finally {
      db.close();
    }
  });

  it("fetches a missing private-thread member before including a management autocomplete target", async () => {
    const db = new CountdownDatabase(":memory:");
    try {
      const nowMs = Date.now();
      db.createCountdown(countdown({
        creatorId: "creator-1",
        channelId: "private-thread",
        startedAtMs: nowMs,
        endsAtMs: nowMs + 600_000,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      }), []);
      const harness = clientWithListener(async () => null);
      const memberFetch = vi.fn().mockResolvedValue({ id: "moderator-1" });
      harness.client.channels.cache.set("private-thread", {
        type: ChannelType.PrivateThread,
        permissionsFor: () => new PermissionsBitField([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ManageMessages,
        ]),
        members: { cache: new Map(), fetch: memberFetch },
      } as never);
      installInteractionHandlers(harness.client, db, {
        siteBaseUrl: "https://onlinealarmkur.com",
        defaultTimezone: "UTC",
      });
      const respond = vi.fn();
      await harness.listener()({
        commandName: "countdown-manage",
        guildId: "guild-1",
        user: { id: "moderator-1" },
        client: harness.client,
        options: { getFocused: () => ({ name: "countdown", value: "" }) },
        isAutocomplete: () => true,
        isChatInputCommand: () => false,
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        isRepliable: () => false,
        respond,
      });

      expect(memberFetch).toHaveBeenCalledWith({ member: "moderator-1", force: true, cache: false });
      expect(respond.mock.calls[0]?.[0]).toEqual([
        expect.objectContaining({ value: "countdown-1" }),
      ]);
    } finally {
      db.close();
    }
  });

  it("deduplicates fresh autocomplete checks and fails closed when their response budget expires", async () => {
    vi.useFakeTimers();
    const db = new CountdownDatabase(":memory:");
    let finish!: (value: unknown) => void;
    const verification = new Promise<unknown>((resolve) => { finish = resolve; });
    try {
      for (const id of ["first", "second"]) {
        db.createCountdown(countdown({ id, messageId: id, endsAtMs: Date.now() + 600_000 }), []);
      }
      const app = clientWithListener(async () => null);
      const fetch = vi.fn().mockReturnValue(verification);
      app.client.channels.cache.set("channel-1", {
        type: ChannelType.PrivateThread,
        permissionsFor: () => new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageMessages]),
        members: { cache: new Map([["moderator-1", {}]]), fetch },
      } as never);
      installInteractionHandlers(app.client, db, { siteBaseUrl: "https://example.test", defaultTimezone: "UTC" });
      const respond = vi.fn();
      const job = app.listener()({
        commandName: "countdown-manage", guildId: "guild-1", user: { id: "moderator-1" }, client: app.client,
        options: { getFocused: () => ({ name: "countdown", value: "" }) },
        isAutocomplete: () => true, respond,
      });
      await vi.advanceTimersByTimeAsync(2_001);
      await job;
      expect(fetch).toHaveBeenCalledOnce();
      expect(respond).toHaveBeenCalledWith([]);
      finish({ id: "moderator-1" });
      await Promise.resolve();
      expect(respond).toHaveBeenCalledOnce();
    } finally {
      finish(null); db.close(); vi.useRealTimers();
    }
  });

  it("does not resurrect a countdown cancelled while a management permission fetch is pending", async () => {
    const db = new CountdownDatabase(":memory:");
    try {
      const nowMs = Date.now();
      db.createCountdown(countdown({
        creatorId: "creator-1",
        channelId: "slow-channel",
        startedAtMs: nowMs,
        endsAtMs: nowMs + 600_000,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      }), []);
      let releaseFetch: (channel: unknown) => void = () => undefined;
      const pendingChannel = new Promise<unknown>((resolve) => {
        releaseFetch = resolve;
      });
      const harness = clientWithListener(async () => pendingChannel);
      installInteractionHandlers(harness.client, db, {
        siteBaseUrl: "https://onlinealarmkur.com",
        defaultTimezone: "UTC",
      });
      const interaction = commandInteraction(harness.client, "countdown-manage", {
        countdown: "countdown-1",
        action: "add",
      });
      const job = harness.listener()(interaction);
      await Promise.resolve();

      const fresh = db.getCountdown("countdown-1");
      if (!fresh) throw new Error("Expected stored countdown");
      expect(db.updateCountdown({
        ...fresh,
        state: "cancelled",
        endsAtMs: null,
        updatedAtMs: nowMs + 1,
      })).toBe(true);
      releaseFetch({
        permissionsFor: () => new PermissionsBitField([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ManageMessages,
        ]),
      });
      await job;

      expect(db.getCountdown("countdown-1")?.state).toBe("cancelled");
      expect(interaction.editReply).toHaveBeenCalledWith({ content: "That countdown has already ended." });
    } finally {
      db.close();
    }
  });

  it("retries a transient management-card edit and records the repaired card", async () => {
    const db = new CountdownDatabase(":memory:");
    try {
      const nowMs = Date.now();
      db.createCountdown(countdown({
        creatorId: "creator-1",
        startedAtMs: nowMs,
        endsAtMs: nowMs + 600_000,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      }), []);
      const messageEdit = vi.fn()
        .mockRejectedValueOnce(new Error("transient edit failure"))
        .mockResolvedValue({});
      const channel = {
        permissionsFor: () => new PermissionsBitField([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ManageMessages,
        ]),
        isTextBased: () => true,
        messages: { fetch: vi.fn().mockResolvedValue({ id: "message-1", edit: messageEdit }) },
      };
      const harness = clientWithListener(async () => channel);
      installInteractionHandlers(harness.client, db, {
        siteBaseUrl: "https://onlinealarmkur.com",
        defaultTimezone: "UTC",
      });
      const interaction = commandInteraction(harness.client, "countdown-manage", {
        countdown: "countdown-1",
        action: "cancel",
      });

      await harness.listener()(interaction);
      expect(messageEdit).toHaveBeenCalledTimes(2);
      expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining("Updated"),
      }));
      expect(db.getPendingCardUpdateIds(Date.now() + 1_000)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("does not autocomplete an impossible calendar date typed by the user", async () => {
    const db = new CountdownDatabase(":memory:");
    try {
      const harness = clientWithListener(async () => null);
      installInteractionHandlers(harness.client, db, {
        siteBaseUrl: "https://onlinealarmkur.com",
        defaultTimezone: "UTC",
      });
      const respond = vi.fn();
      await harness.listener()({
        commandName: "countdown",
        guildId: "guild-1",
        user: { id: "user-1" },
        client: harness.client,
        options: {
          getFocused: () => ({ name: "when", value: "2030-02-30 12:00" }),
          getString: (name: string) => name === "timezone" ? "UTC" : null,
        },
        isAutocomplete: () => true,
        isChatInputCommand: () => false,
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        isRepliable: () => false,
        respond,
      });

      const choices = respond.mock.calls[0]?.[0] as Array<{ value: string }>;
      expect(choices.some(({ value }) => value === "2030-02-30 12:00")).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe("interaction race recovery", () => {
  type Listener = (interaction: any) => Promise<void>;

  function harness(): { client: Client; listener(): Listener } {
    let captured: Listener | undefined;
    const client = {
      channels: { cache: new Map(), fetch: vi.fn() },
      on: (_event: string, listener: Listener) => { captured = listener; },
      off: vi.fn(),
    } as unknown as Client;
    return {
      client,
      listener: () => {
        if (!captured) throw new Error("Expected installed listener");
        return captured;
      },
    };
  }

  function button(client: Client, customId: string, update: (payload: unknown) => Promise<void>, message: unknown) {
    return {
      customId,
      guildId: "guild-1",
      channelId: "channel-1",
      user: { id: "creator-1" },
      client,
      message,
      memberPermissions: new PermissionsBitField([PermissionFlagsBits.SendMessages]),
      deferred: false,
      replied: false,
      isAutocomplete: () => false,
      isChatInputCommand: () => false,
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      isRepliable: () => false,
      update,
      followUp: vi.fn(),
    };
  }

  it("repairs a card when a slower old control response lands after a newer cancellation", async () => {
    const db = new CountdownDatabase(":memory:");
    try {
      const nowMs = Date.now();
      db.createCountdown(countdown({
        startedAtMs: nowMs,
        endsAtMs: nowMs + 600_000,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      }), []);
      const app = harness();
      installInteractionHandlers(app.client, db, {
        siteBaseUrl: "https://onlinealarmkur.com",
        defaultTimezone: "UTC",
      });
      let releaseOld: () => void = () => undefined;
      const oldResponse = new Promise<void>((resolve) => { releaseOld = resolve; });
      const message = { id: "message-1", edit: vi.fn().mockResolvedValue({}) };
      const add = button(app.client, "countdown:add:countdown-1", vi.fn(async () => oldResponse), message);
      const cancel = button(app.client, "countdown:cancel:countdown-1", vi.fn(), message);

      const oldJob = app.listener()(add);
      await Promise.resolve();
      await app.listener()(cancel);
      expect(db.getCountdown("countdown-1")?.state).toBe("cancelled");
      releaseOld();
      await oldJob;

      const repaired = message.edit.mock.calls.at(-1)?.[0] as { embeds?: Array<{ toJSON(): any }> };
      const fields = repaired.embeds?.[0]?.toJSON().fields as Array<{ name: string; value: string }>;
      expect(fields.find(({ name }) => name === "Status")?.value).toBe("Cancelled");
    } finally {
      db.close();
    }
  });

  it("rechecks after a delayed repair so a third control cannot leave the card one version behind", async () => {
    const db = new CountdownDatabase(":memory:");
    try {
      const nowMs = Date.now();
      db.createCountdown(countdown({
        startedAtMs: nowMs,
        endsAtMs: nowMs + 600_000,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      }), []);
      const app = harness();
      installInteractionHandlers(app.client, db, {
        siteBaseUrl: "https://onlinealarmkur.com",
        defaultTimezone: "UTC",
      });
      let releaseOldResponse: () => void = () => undefined;
      const oldResponse = new Promise<void>((resolve) => { releaseOldResponse = resolve; });
      let releaseOldRepair: () => void = () => undefined;
      const oldRepair = new Promise<void>((resolve) => { releaseOldRepair = resolve; });
      const message = {
        id: "message-1",
        edit: vi.fn()
          .mockImplementationOnce(async () => oldRepair)
          .mockResolvedValue({}),
      };

      const oldest = app.listener()(button(
        app.client,
        "countdown:add:countdown-1",
        vi.fn(async () => oldResponse),
        message,
      ));
      await Promise.resolve();
      await app.listener()(button(app.client, "countdown:add:countdown-1", vi.fn(), message));
      releaseOldResponse();
      for (let index = 0; index < 10 && message.edit.mock.calls.length === 0; index += 1) {
        await Promise.resolve();
      }
      expect(message.edit).toHaveBeenCalledOnce();

      await app.listener()(button(app.client, "countdown:cancel:countdown-1", vi.fn(), message));
      releaseOldRepair();
      await oldest;

      expect(db.getCountdown("countdown-1")).toMatchObject({ state: "cancelled", version: 3 });
      const repaired = message.edit.mock.calls.at(-1)?.[0] as { embeds?: Array<{ toJSON(): any }> };
      const fields = repaired.embeds?.[0]?.toJSON().fields as Array<{ name: string; value: string }>;
      expect(fields.find(({ name }) => name === "Status")?.value).toBe("Cancelled");
      expect(message.edit).toHaveBeenCalledTimes(2);
    } finally {
      db.close();
    }
  });

  it("arms a quick countdown before publishing its live card", async () => {
    const db = new CountdownDatabase(":memory:");
    try {
      db.createPicker("picker-1", "creator-1", Date.now());
      const app = harness();
      installInteractionHandlers(app.client, db, {
        siteBaseUrl: "https://onlinealarmkur.com",
        defaultTimezone: "UTC",
      });
      const message = { id: "picker-1", edit: vi.fn() };
      let armedInsideUpdate = false;
      const interaction = {
        ...button(app.client, "countdown:preset:creator-1:silent:5m", vi.fn(async () => {
          const row = db.database.prepare("SELECT armed_at_ms FROM countdowns LIMIT 1").get() as
            | { armed_at_ms: number | null }
            | undefined;
          armedInsideUpdate = row?.armed_at_ms !== null && row?.armed_at_ms !== undefined;
        }), message),
        member: null,
        guild: { members: { me: null } },
      };

      await app.listener()(interaction);
      expect(armedInsideUpdate).toBe(true);
      expect(db.getCountdownByMessageId("picker-1")).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it("repairs quick buttons after a crashed sound update changes the durable selection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const db = new CountdownDatabase(":memory:");
    try {
      db.createPicker("picker-1", "creator-1", Date.now());
      expect(db.beginPickerSoundUpdate("picker-1", "creator-1", "beep", Date.now()))
        .toEqual(expect.any(String));
      vi.advanceTimersByTime(31_000);
      const app = harness();
      installInteractionHandlers(app.client, db, {
        siteBaseUrl: "https://onlinealarmkur.com",
        defaultTimezone: "UTC",
      });
      const message = { id: "picker-1", edit: vi.fn().mockResolvedValue({}) };
      const interaction = {
        ...button(
          app.client,
          "countdown:preset:creator-1:silent:5m",
          vi.fn(),
          message,
        ),
        member: null,
        guild: { members: { me: null } },
      };
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      await app.listener()(interaction);

      expect(db.getPickerSoundIfOpen("picker-1", "creator-1")).toBe("beep");
      expect(db.database.prepare("SELECT COUNT(*) AS count FROM countdowns").get()).toMatchObject({ count: 0 });
      expect(message.edit.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
        content: expect.stringContaining("Beep"),
      }));
    } finally {
      db.close();
      vi.useRealTimers();
    }
  });

  it("repairs a custom picker form after a crashed sound update changes the durable selection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const db = new CountdownDatabase(":memory:");
    try {
      db.createPicker("picker-1", "creator-1", Date.now());
      expect(db.beginPickerSoundUpdate("picker-1", "creator-1", "beep", Date.now()))
        .toEqual(expect.any(String));
      vi.advanceTimersByTime(31_000);
      const app = harness();
      installInteractionHandlers(app.client, db, {
        siteBaseUrl: "https://onlinealarmkur.com",
        defaultTimezone: "UTC",
      });
      const message = { id: "picker-1", edit: vi.fn().mockResolvedValue({}) };
      const values: Record<string, string> = { when: "5m", label: "", timezone: "UTC" };
      const interaction = {
        customId: "countdown:custom:creator-1:silent",
        guildId: "guild-1",
        channelId: "channel-1",
        user: { id: "creator-1" },
        client: app.client,
        message,
        member: null,
        guild: { members: { me: null } },
        fields: { getTextInputValue: (name: string) => values[name] ?? "" },
        deferred: false,
        replied: false,
        isFromMessage: () => true,
        isAutocomplete: () => false,
        isChatInputCommand: () => false,
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => true,
        isRepliable: () => false,
        update: vi.fn(),
        followUp: vi.fn(),
      };
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      await app.listener()(interaction);

      expect(db.getPickerSoundIfOpen("picker-1", "creator-1")).toBe("beep");
      expect(db.database.prepare("SELECT COUNT(*) AS count FROM countdowns").get()).toMatchObject({ count: 0 });
      expect(message.edit.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
        content: expect.stringContaining("Beep"),
      }));
    } finally {
      db.close();
      vi.useRealTimers();
    }
  });

  it("keeps a legacy quick picker open when its sound changes before atomic consume", async () => {
    const db = new CountdownDatabase(":memory:");
    try {
      db.createPicker("picker-1", "creator-1", Date.now());
      const consume = db.consumePicker.bind(db);
      vi.spyOn(db, "consumePicker").mockImplementationOnce((...args) => {
        const token = db.beginPickerSoundUpdate("picker-1", "creator-1", "beep", Date.now());
        if (!token || !db.finishPickerSoundUpdate("picker-1", "creator-1", token, true, Date.now())) {
          throw new Error("Expected interleaved sound update");
        }
        return consume(...args);
      });
      const app = harness();
      installInteractionHandlers(app.client, db, {
        siteBaseUrl: "https://onlinealarmkur.com",
        defaultTimezone: "UTC",
      });
      const message = { id: "picker-1", edit: vi.fn().mockResolvedValue({}) };
      const interaction = {
        ...button(app.client, "countdown:preset:creator-1:5m", vi.fn(), message),
        member: null,
        guild: { members: { me: null } },
      };
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      await app.listener()(interaction);

      expect(db.getPickerSoundIfOpen("picker-1", "creator-1")).toBe("beep");
      expect(db.database.prepare("SELECT COUNT(*) AS count FROM countdowns").get()).toMatchObject({ count: 0 });
      expect(message.edit.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
        content: expect.stringContaining("Beep"),
      }));
    } finally {
      db.close();
    }
  });

  it("repairs an old losing-preset card after the winning preset rolls back to the picker", async () => {
    const db = new CountdownDatabase(":memory:");
    try {
      db.createPicker("picker-1", "creator-1", Date.now());
      const app = harness();
      installInteractionHandlers(app.client, db, {
        siteBaseUrl: "https://onlinealarmkur.com",
        defaultTimezone: "UTC",
      });
      let rejectWinner: (error: Error) => void = () => undefined;
      const winnerUpdate = new Promise<void>((_resolve, reject) => { rejectWinner = reject; });
      let releaseOldCard: () => void = () => undefined;
      const oldCard = new Promise<void>((resolve) => { releaseOldCard = resolve; });
      let visible: unknown;
      const message = {
        id: "picker-1",
        edit: vi.fn().mockImplementation(async (payload: unknown) => {
          if (message.edit.mock.calls.length === 1) await oldCard;
          visible = payload;
          return {};
        }),
      };
      const preset = (update: (payload: unknown) => Promise<void>) => ({
        ...button(app.client, "countdown:preset:creator-1:silent:5m", update, message),
        member: null,
        guild: { members: { me: null } },
      });
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      const winner = app.listener()(preset(vi.fn(async () => winnerUpdate)));
      for (let index = 0; index < 10 && !db.getCountdownByMessageId("picker-1"); index += 1) {
        await Promise.resolve();
      }
      expect(db.getCountdownByMessageId("picker-1")).not.toBeNull();

      const loser = app.listener()(preset(vi.fn()));
      for (let index = 0; index < 10 && message.edit.mock.calls.length === 0; index += 1) {
        await Promise.resolve();
      }
      expect(message.edit).toHaveBeenCalledOnce();

      rejectWinner(Object.assign(new Error("Unknown interaction"), { code: 10_062 }));
      await winner;
      expect(db.getPickerSoundIfOpen("picker-1", "creator-1")).toBe("silent");
      expect(db.getCountdownByMessageId("picker-1")).toBeNull();

      releaseOldCard();
      await loser;

      expect(message.edit).toHaveBeenCalledTimes(3);
      expect(visible).toEqual(expect.objectContaining({
        content: expect.stringContaining("Text only (no beep)"),
      }));
      expect(db.getPickerSoundIfOpen("picker-1", "creator-1")).toBe("silent");
      expect(db.getCountdownByMessageId("picker-1")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("arms a direct slash-command countdown before replacing the deferred reply with its card", async () => {
    const db = new CountdownDatabase(":memory:");
    try {
      const app = harness();
      installInteractionHandlers(app.client, db, {
        siteBaseUrl: "https://onlinealarmkur.com",
        defaultTimezone: "UTC",
      });
      const interaction: any = {
        commandName: "countdown",
        guildId: "guild-1",
        channelId: "channel-1",
        user: { id: "creator-1" },
        client: app.client,
        member: null,
        guild: { members: { me: null } },
        memberPermissions: new PermissionsBitField([PermissionFlagsBits.SendMessages]),
        deferred: false,
        replied: false,
        options: {
          getString: (name: string) => name === "when" ? "5m" : null,
          getRole: () => null,
        },
        isAutocomplete: () => false,
        isChatInputCommand: () => true,
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        isRepliable: () => false,
        deferReply: vi.fn(async () => { interaction.deferred = true; }),
        fetchReply: vi.fn().mockResolvedValue({ id: "direct-message-1" }),
        editReply: vi.fn(async () => {
          const stored = db.getCountdownByMessageId("direct-message-1");
          expect(stored).toMatchObject({ messageId: "direct-message-1", version: 1 });
        }),
        followUp: vi.fn(),
      };

      await app.listener()(interaction);
      expect(interaction.deferReply).toHaveBeenCalledOnce();
      expect(interaction.editReply).toHaveBeenCalledOnce();
      expect(db.getCountdownByMessageId("direct-message-1")).not.toBeNull();
    } finally {
      db.close();
    }
  });

  const botCanPost = new PermissionsBitField([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.SendMessagesInThreads,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory,
  ]);

  it.each([
    {
      reason: "the bot is missing Embed Links",
      appPermissions: new PermissionsBitField([
        PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory,
      ]),
      memberPermissions: new PermissionsBitField([PermissionFlagsBits.SendMessages]),
      inThread: false,
      expected: /missing Embed Links in this channel/,
    },
    {
      reason: "the bot can't send in the thread",
      appPermissions: new PermissionsBitField([
        PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory,
      ]),
      memberPermissions: new PermissionsBitField([PermissionFlagsBits.SendMessagesInThreads]),
      inThread: true,
      expected: /missing Send Messages in Threads/,
    },
    {
      reason: "the member can't send messages there",
      appPermissions: botCanPost,
      memberPermissions: new PermissionsBitField([PermissionFlagsBits.ViewChannel]),
      inThread: false,
      expected: /can't send messages in this channel/,
    },
  ])("refuses a countdown where $reason", async ({ appPermissions, memberPermissions, inThread, expected }) => {
    const db = new CountdownDatabase(":memory:");
    try {
      const app = harness();
      installInteractionHandlers(app.client, db, {
        siteBaseUrl: "https://onlinealarmkur.com",
        defaultTimezone: "UTC",
      });
      const interaction: any = {
        commandName: "countdown",
        guildId: "guild-1",
        channelId: "channel-1",
        channel: { isThread: () => inThread },
        user: { id: "creator-1" },
        client: app.client,
        member: null,
        guild: { members: { me: null } },
        appPermissions,
        memberPermissions,
        deferred: false,
        replied: false,
        options: {
          getString: (name: string) => name === "when" ? "5m" : null,
          getRole: () => null,
        },
        isAutocomplete: () => false,
        isChatInputCommand: () => true,
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        isRepliable: () => true,
        deferReply: vi.fn(),
        reply: vi.fn().mockResolvedValue(undefined),
      };

      await app.listener()(interaction);
      expect(interaction.deferReply).not.toHaveBeenCalled();
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringMatching(expected),
        flags: MessageFlags.Ephemeral,
      }));
      expect(db.countActive("guild-1", undefined, Date.now())).toBe(0);
    } finally {
      db.close();
    }
  });

  it("explains that pruned quick buttons expired instead of asking to retry", async () => {
    const db = new CountdownDatabase(":memory:");
    try {
      const app = harness();
      installInteractionHandlers(app.client, db, {
        siteBaseUrl: "https://onlinealarmkur.com",
        defaultTimezone: "UTC",
      });
      const interaction: any = {
        ...button(app.client, "countdown:preset:creator-1:silent:5m", vi.fn(), { id: "pruned-picker-1" }),
        appPermissions: botCanPost,
        isRepliable: () => true,
        reply: vi.fn().mockResolvedValue(undefined),
      };

      await app.listener()(interaction);
      expect(interaction.update).not.toHaveBeenCalled();
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: "These quick buttons have expired. Run `/countdown` again.",
      }));
      expect(db.countActive("guild-1", undefined, Date.now())).toBe(0);
    } finally {
      db.close();
    }
  });

  it("rolls back a direct countdown when publishing its card is definitively rejected", async () => {
    const db = new CountdownDatabase(":memory:");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const app = harness();
      installInteractionHandlers(app.client, db, { siteBaseUrl: "https://example.test", defaultTimezone: "UTC" });
      const rejected = Object.assign(new Error("Missing permissions"), { code: 50013 });
      const message = { id: "direct-rejected", edit: vi.fn().mockRejectedValue(rejected) };
      const interaction = {
        commandName: "countdown", guildId: "guild-1", channelId: "channel-1", user: { id: "creator-1" },
        client: app.client, member: null, guild: { members: { me: null } },
        memberPermissions: new PermissionsBitField([PermissionFlagsBits.SendMessages]),
        options: { getString: (name: string) => name === "when" ? "5m" : null, getRole: () => null },
        isAutocomplete: () => false, isChatInputCommand: () => true, isRepliable: () => false,
        deferReply: vi.fn(), fetchReply: vi.fn().mockResolvedValue(message),
        editReply: vi.fn().mockRejectedValue(rejected), followUp: vi.fn(),
      };
      await app.listener()(interaction);
      expect(db.getCountdownByMessageId(message.id)).toBeNull();
      expect(db.countActive("guild-1", "creator-1")).toBe(0);
      expect(db.getDueCountdowns(Date.now() + 600_000)).toEqual([]);
    } finally {
      log.mockRestore();
      db.close();
    }
  });

  it.each([undefined, 50013])("preserves a concurrently completed direct creation after publication error %s", async (code) => {
    const db = new CountdownDatabase(":memory:");
    try {
      const app = harness();
      installInteractionHandlers(app.client, db, {
        siteBaseUrl: "https://onlinealarmkur.com",
        defaultTimezone: "UTC",
      });
      let rejectInitialEdit: (error: Error) => void = () => undefined;
      const initialEdit = new Promise<void>((_resolve, reject) => { rejectInitialEdit = reject; });
      const message = { id: "direct-message-1", edit: vi.fn().mockResolvedValue({}) };
      const interaction: any = {
        commandName: "countdown",
        guildId: "guild-1",
        channelId: "channel-1",
        user: { id: "creator-1" },
        client: app.client,
        member: null,
        guild: { members: { me: null } },
        memberPermissions: new PermissionsBitField([PermissionFlagsBits.SendMessages]),
        deferred: false,
        replied: false,
        options: {
          getString: (name: string) => name === "when" ? "5s" : null,
          getRole: () => null,
        },
        isAutocomplete: () => false,
        isChatInputCommand: () => true,
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        isRepliable: () => false,
        deferReply: vi.fn(async () => { interaction.deferred = true; }),
        fetchReply: vi.fn().mockResolvedValue(message),
        editReply: vi.fn(async () => initialEdit),
        followUp: vi.fn(),
      };

      const job = app.listener()(interaction);
      for (let index = 0; index < 10 && !db.getCountdownByMessageId("direct-message-1"); index += 1) {
        await Promise.resolve();
      }
      const stored = db.getCountdownByMessageId("direct-message-1");
      if (!stored?.endsAtMs) throw new Error("Expected armed countdown");
      db.finalizeDueCountdowns(stored.endsAtMs);
      rejectInitialEdit(Object.assign(new Error("Discord edit failure"), { code }));
      await job;

      expect(db.getCountdownByMessageId("direct-message-1")?.state).toBe("completed");
      const repaired = message.edit.mock.calls.at(-1)?.[0] as { embeds?: Array<{ toJSON(): any }> };
      const fields = repaired.embeds?.[0]?.toJSON().fields as Array<{ name: string; value: string }>;
      expect(fields.find(({ name }) => name === "Status")?.value).toBe("Time's up");
    } finally {
      db.close();
    }
  });

  it("removes an unarmed draft when deferring the direct command fails", async () => {
    const db = new CountdownDatabase(":memory:");
    try {
      const app = harness();
      installInteractionHandlers(app.client, db, {
        siteBaseUrl: "https://onlinealarmkur.com",
        defaultTimezone: "UTC",
      });
      const interaction: any = {
        commandName: "countdown",
        guildId: "guild-1",
        channelId: "channel-1",
        user: { id: "creator-1" },
        client: app.client,
        member: null,
        guild: { members: { me: null } },
        memberPermissions: new PermissionsBitField([PermissionFlagsBits.SendMessages]),
        deferred: false,
        replied: false,
        options: {
          getString: (name: string) => name === "when" ? "5m" : null,
          getRole: () => null,
        },
        isAutocomplete: () => false,
        isChatInputCommand: () => true,
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        isRepliable: () => false,
        deferReply: vi.fn().mockRejectedValue(new Error("Discord unavailable")),
        fetchReply: vi.fn(),
        editReply: vi.fn(),
        followUp: vi.fn(),
      };
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      await app.listener()(interaction);
      expect(db.database.prepare("SELECT COUNT(*) AS count FROM countdowns").get()).toMatchObject({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("reopens and restores the quick picker when publishing the card fails", async () => {
    const db = new CountdownDatabase(":memory:");
    try {
      db.createPicker("picker-1", "creator-1", Date.now());
      const app = harness();
      installInteractionHandlers(app.client, db, {
        siteBaseUrl: "https://onlinealarmkur.com",
        defaultTimezone: "UTC",
      });
      const message = { id: "picker-1", edit: vi.fn().mockResolvedValue({}) };
      const interaction = {
        ...button(
          app.client,
          "countdown:preset:creator-1:silent:5m",
          vi.fn().mockRejectedValue(Object.assign(
            new Error("Unknown interaction"),
            { code: 10_062 },
          )),
          message,
        ),
        member: null,
        guild: { members: { me: null } },
      };
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      await app.listener()(interaction);
      expect(db.getPickerSoundIfOpen("picker-1", "creator-1")).toBe("silent");
      expect(db.database.prepare("SELECT COUNT(*) AS count FROM countdowns").get()).toMatchObject({ count: 0 });
      expect(message.edit).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining("Text only (no beep)"),
      }));
    } finally {
      db.close();
    }
  });

  it("does not delete a quick countdown changed while an ambiguous publish failure is pending", async () => {
    const db = new CountdownDatabase(":memory:");
    try {
      db.createPicker("picker-1", "creator-1", Date.now());
      const app = harness();
      installInteractionHandlers(app.client, db, {
        siteBaseUrl: "https://onlinealarmkur.com",
        defaultTimezone: "UTC",
      });
      let rejectPublish: (error: Error) => void = () => undefined;
      const publish = new Promise<void>((_resolve, reject) => { rejectPublish = reject; });
      const message = { id: "picker-1", edit: vi.fn().mockResolvedValue({}) };
      const interaction = {
        ...button(
          app.client,
          "countdown:preset:creator-1:silent:5m",
          vi.fn(async () => publish),
          message,
        ),
        member: null,
        guild: { members: { me: null } },
      };

      const job = app.listener()(interaction);
      for (let index = 0; index < 10 && !db.getCountdownByMessageId("picker-1"); index += 1) {
        await Promise.resolve();
      }
      const stored = db.getCountdownByMessageId("picker-1");
      if (!stored?.endsAtMs) throw new Error("Expected armed quick countdown");
      expect(db.updateCountdown({
        ...stored,
        endsAtMs: stored.endsAtMs + 60_000,
        durationMs: stored.durationMs + 60_000,
        remainingMs: stored.remainingMs + 60_000,
      })).toBe(true);
      rejectPublish(new Error("Ambiguous Discord update failure"));
      await job;

      expect(db.getCountdownByMessageId("picker-1")).toMatchObject({ version: 2 });
      expect(db.getPickerSoundIfOpen("picker-1", "creator-1")).toBeNull();
      expect(message.edit).toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("repairs a stale sound-menu response to the newest selected sound", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const db = new CountdownDatabase(":memory:");
    try {
      db.createPicker("picker-1", "creator-1", Date.now());
      const app = harness();
      installInteractionHandlers(app.client, db, {
        siteBaseUrl: "https://onlinealarmkur.com",
        defaultTimezone: "UTC",
      });
      let releaseOld: () => void = () => undefined;
      const blocked = new Promise<void>((resolve) => { releaseOld = resolve; });
      const message = { id: "picker-1", edit: vi.fn().mockResolvedValue({}) };
      const soundInteraction = (sound: string, update: () => Promise<void>) => ({
        customId: "countdown:sound:creator-1",
        values: [sound],
        user: { id: "creator-1" },
        message,
        deferred: false,
        replied: false,
        isAutocomplete: () => false,
        isChatInputCommand: () => false,
        isButton: () => false,
        isStringSelectMenu: () => true,
        isModalSubmit: () => false,
        isRepliable: () => false,
        update,
      });
      const oldJob = app.listener()(soundInteraction("beep", vi.fn(async () => blocked)));
      await Promise.resolve();
      vi.advanceTimersByTime(31_000);
      await app.listener()(soundInteraction("bell", vi.fn()));
      releaseOld();
      await oldJob;

      expect(db.getPickerSoundIfOpen("picker-1", "creator-1")).toBe("bell");
      expect(message.edit.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
        content: expect.stringContaining("Bell"),
      }));
    } finally {
      db.close();
      vi.useRealTimers();
    }
  });

  it("rechecks picker state after a delayed repair so a third sound selection wins", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const db = new CountdownDatabase(":memory:");
    try {
      db.createPicker("picker-1", "creator-1", Date.now());
      const app = harness();
      installInteractionHandlers(app.client, db, {
        siteBaseUrl: "https://onlinealarmkur.com",
        defaultTimezone: "UTC",
      });
      let releaseOldUpdate: () => void = () => undefined;
      const oldUpdate = new Promise<void>((resolve) => { releaseOldUpdate = resolve; });
      let releaseOldRepair: () => void = () => undefined;
      const oldRepair = new Promise<void>((resolve) => { releaseOldRepair = resolve; });
      const message = {
        id: "picker-1",
        edit: vi.fn()
          .mockImplementationOnce(async () => oldRepair)
          .mockResolvedValue({}),
      };
      const soundInteraction = (sound: string, update: () => Promise<void>) => ({
        customId: "countdown:sound:creator-1",
        values: [sound],
        user: { id: "creator-1" },
        message,
        deferred: false,
        replied: false,
        isAutocomplete: () => false,
        isChatInputCommand: () => false,
        isButton: () => false,
        isStringSelectMenu: () => true,
        isModalSubmit: () => false,
        isRepliable: () => false,
        update,
      });

      const oldJob = app.listener()(soundInteraction("beep", vi.fn(async () => oldUpdate)));
      await Promise.resolve();
      vi.advanceTimersByTime(31_000);
      await app.listener()(soundInteraction("bell", vi.fn()));
      releaseOldUpdate();
      for (let index = 0; index < 10 && message.edit.mock.calls.length === 0; index += 1) {
        await Promise.resolve();
      }
      expect(message.edit).toHaveBeenCalledOnce();
      await app.listener()(soundInteraction("urgent", vi.fn()));
      releaseOldRepair();
      await oldJob;

      expect(db.getPickerSoundIfOpen("picker-1", "creator-1")).toBe("urgent");
      expect(message.edit.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
        content: expect.stringContaining("Urgent"),
      }));
      expect(message.edit).toHaveBeenCalledTimes(2);
    } finally {
      db.close();
      vi.useRealTimers();
    }
  });

  it("repairs the picker when a timed-out sound update later fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const db = new CountdownDatabase(":memory:");
    try {
      db.createPicker("picker-1", "creator-1", Date.now());
      const app = harness();
      installInteractionHandlers(app.client, db, {
        siteBaseUrl: "https://onlinealarmkur.com",
        defaultTimezone: "UTC",
      });
      let rejectUpdate: (error: Error) => void = () => undefined;
      const blocked = new Promise<void>((_resolve, reject) => { rejectUpdate = reject; });
      const message = { id: "picker-1", edit: vi.fn().mockResolvedValue({}) };
      const interaction = {
        customId: "countdown:sound:creator-1",
        values: ["beep"],
        user: { id: "creator-1" },
        message,
        deferred: false,
        replied: false,
        isAutocomplete: () => false,
        isChatInputCommand: () => false,
        isButton: () => false,
        isStringSelectMenu: () => true,
        isModalSubmit: () => false,
        isRepliable: () => false,
        update: vi.fn(async () => blocked),
      };
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const job = app.listener()(interaction);
      await Promise.resolve();
      vi.advanceTimersByTime(31_000);
      expect(db.getPickerSoundIfOpen("picker-1", "creator-1")).toBe("beep");
      rejectUpdate(new Error("Discord update failed"));
      await job;

      expect(message.edit.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
        content: expect.stringContaining("Beep"),
      }));
    } finally {
      db.close();
      vi.useRealTimers();
    }
  });
});

describe("voice alert preflight", () => {
  const botMember = {} as GuildMember;
  const voiceChannel = (permissions: bigint[], full = false): VoiceBasedChannel => ({
    id: "voice-1",
    type: ChannelType.GuildVoice,
    full,
    permissionsFor: () => new PermissionsBitField(permissions),
  }) as unknown as VoiceBasedChannel;
  const allVoicePermissions = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.Connect,
    PermissionFlagsBits.Speak,
  ];

  it.each(["beep", "bell", "urgent"] as const)("keeps %s when the bot can join and speak", (sound) => {
    expect(resolveVoiceAlert(sound, voiceChannel(allVoicePermissions), botMember)).toEqual({
      sound,
      voiceChannelId: "voice-1",
      fallbackReason: null,
    });
  });

  it("keeps text only as the dependable default without inspecting voice", () => {
    expect(resolveVoiceAlert("silent", null, null)).toEqual({
      sound: "silent",
      voiceChannelId: null,
      fallbackReason: null,
    });
  });

  it("falls back to text for no channel, Stage, missing Speak, and a full channel", () => {
    const stage = { id: "stage-1", type: ChannelType.GuildStageVoice } as VoiceBasedChannel;
    const missingSpeak = allVoicePermissions.filter((permission) => permission !== PermissionFlagsBits.Speak);
    expect(resolveVoiceAlert("beep", null, botMember).sound).toBe("silent");
    expect(resolveVoiceAlert("beep", stage, botMember).fallbackReason).toContain("Stage");
    expect(resolveVoiceAlert("bell", voiceChannel(missingSpeak), botMember).fallbackReason).toContain("Speak");
    expect(resolveVoiceAlert("urgent", voiceChannel(allVoicePermissions, true), botMember).fallbackReason)
      .toContain("full");
  });

  it.each([
    ["returns no permissions", () => null],
    ["throws", () => { throw new Error("resolver unavailable"); }],
  ])("falls back to text when the permission resolver %s", (_name, permissionsFor) => {
    const unresolved = {
      id: "voice-1",
      type: ChannelType.GuildVoice,
      full: false,
      permissionsFor,
    } as unknown as VoiceBasedChannel;

    expect(resolveVoiceAlert("beep", unresolved, botMember)).toEqual({
      sound: "silent",
      voiceChannelId: null,
      fallbackReason: "the bot could not verify its voice permissions.",
    });
  });

  it("allows a full channel when the bot can move members", () => {
    expect(resolveVoiceAlert(
      "beep",
      voiceChannel([...allVoicePermissions, PermissionFlagsBits.MoveMembers], true),
      botMember,
    ).sound).toBe("beep");
  });
});
