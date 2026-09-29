import { ChannelType, Client, Events, GatewayIntentBits, Options, RESTEvents } from "discord.js";
import { loadConfig } from "./config.js";
import { CountdownDatabase } from "./database.js";
import { installInteractionHandlers } from "./discord/handlers.js";
import { CountdownScheduler } from "./services/scheduler.js";

// Delivery claims survive a restart, so shutdown need not wait for every
// queued chime. Stay well inside the service manager's stop timeout.
const DRAIN_DEADLINE_MS = 20_000;
const HOUR_MS = 3_600_000;

const config = loadConfig();
const database = new CountdownDatabase(config.databasePath);
database.bindApplication(config.clientId);
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  // Discord requires sharding from 2,500 servers. Internal shards keep one
  // process and one SQLite writer; multi-process sharding is not supported.
  shards: "auto",
  // Discord bans an IP for 10,000 invalid (401/403/429) requests in 10 minutes.
  rest: { invalidRequestWarningInterval: 500 },
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 0,
    // permissionsFor(userId) resolves members from this cache, so keep recent
    // interaction members. Voice routing needs the bot's own member.
    GuildMemberManager: { maxSize: 500, keepOverLimit: (member) => member.id === member.client.user.id },
  }),
  sweepers: {
    ...Options.DefaultSweeperSettings,
    users: { interval: HOUR_MS / 1_000, filter: () => (user) => user.id !== user.client.user.id },
    // States of members still in voice are needed to capture a chime channel.
    voiceStates: { interval: HOUR_MS / 1_000, filter: () => (state) => state.channelId === null },
  },
});
const scheduler = new CountdownScheduler(client, database, config);
client.rest.on(RESTEvents.InvalidRequestWarning, ({ count, remainingTime }) => {
  console.error(`Discord invalid-request warning: ${count} in the current 10-minute window (${Math.ceil(remainingTime / 1_000)}s left).`);
});

const interactionHandlers = installInteractionHandlers(client, database, config);
// Direct-message channels cannot be size-limited and are recreated on demand.
const dmChannelSweep = setInterval(() => {
  client.channels.cache.sweep((channel) => channel.type === ChannelType.DM);
}, HOUR_MS);
dmChannelSweep.unref();

client.once(Events.ClientReady, (readyClient) => {
  // The cache lists every server the bot belongs to, including ones in an
  // outage. Anything else was removed while the bot was offline.
  const departed = database.listGuildIds().filter((guildId) => !readyClient.guilds.cache.has(guildId));
  for (const guildId of departed) database.deleteGuildData(guildId);
  console.log(`Countdown Bot is ready as ${readyClient.user.tag} in ${readyClient.guilds.cache.size} servers.`);
  if (departed.length > 0) console.log(`Deleted countdown data for ${departed.length} servers that removed the bot while it was offline.`);
  scheduler.start();
});

// Outages arrive as GuildUnavailable; GuildDelete means the bot was removed.
client.on(Events.GuildDelete, (guild) => {
  try {
    const deleted = database.deleteGuildData(guild.id);
    console.log(`Removed from a server; deleted ${deleted} countdowns.`);
  } catch (error) {
    console.error("Failed to delete countdown data for a removed server", error);
  }
});

// Invalid token, sharding required, or disallowed intents: discord.js will not
// reconnect. Exit non-zero so the service manager restarts or reports it.
client.on(Events.ShardDisconnect, (event, shardId) => {
  console.error(`Discord shard ${shardId} closed permanently with code ${event.code}.`);
  void shutdown("ShardDisconnect", 1);
});

let shutdownPromise: Promise<void> | undefined;

function shutdown(signal: string, initialExitCode = 0): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    console.log(`Received ${signal}; shutting down.`);
    clearInterval(dmChannelSweep);
    scheduler.stop();
    interactionHandlers.stop();
    let exitCode = initialExitCode;
    let deadline: NodeJS.Timeout | undefined;
    const drainResults = await Promise.race([
      Promise.allSettled([scheduler.drain(), interactionHandlers.drain()]),
      new Promise<"timeout">((resolve) => {
        deadline = setTimeout(resolve, DRAIN_DEADLINE_MS, "timeout");
      }),
    ]);
    clearTimeout(deadline);
    if (drainResults === "timeout") {
      console.error("Stopped waiting for in-flight deliveries; their claims expire and retry after restart.");
    } else {
      for (const result of drainResults) {
        if (result.status === "rejected") {
          exitCode = 1;
          console.error("Failed while draining countdown work", result.reason);
        }
      }
    }
    try {
      await client.destroy();
    } catch (error) {
      exitCode = 1;
      console.error("Failed to destroy the Discord client", error);
    }
    try {
      database.close();
    } catch (error) {
      exitCode = 1;
      console.error("Failed to close the countdown database", error);
    }
    process.exit(exitCode);
  })();
  return shutdownPromise;
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await client.login(config.token);
