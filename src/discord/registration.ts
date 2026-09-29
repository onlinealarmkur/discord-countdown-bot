import { Routes, type REST } from "discord.js";
import type { AppConfig } from "../config.js";
import { commandData } from "./commands.js";

export const REGISTRATION_USAGE = [
  "Usage: npm run commands:register [-- <flag>]",
  "  (no flag)      register the commands in the test server set by DISCORD_GUILD_ID",
  "  --print        print the command JSON offline, without credentials",
  "  --global       register globally for every server (DISCORD_GUILD_ID must be empty)",
  "  --clear-guild  remove the test server's command copies",
].join("\n");

export function registrationMode(args: readonly string[]): "help" | "print" | "guild" | "global" | "clear-guild" {
  if (args.length === 0) return "guild";
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return "help";
  if (args.length === 1 && args[0] === "--print") return "print";
  if (args.length === 1 && args[0] === "--global") return "global";
  if (args.length === 1 && args[0] === "--clear-guild") return "clear-guild";
  throw new Error("Use no flags for test-server registration, --print for offline JSON, --global for explicit global registration, or --clear-guild to remove the test-server copies.");
}

async function assertTokenMatchesApplication(rest: Pick<REST, "get">, clientId: string): Promise<void> {
  const application = await rest.get(Routes.oauth2CurrentApplication()) as { id?: string };
  if (application?.id !== clientId) {
    throw new Error("DISCORD_TOKEN and DISCORD_CLIENT_ID belong to different applications. No commands were changed.");
  }
}

/**
 * After global release, the test server would list each command twice: its
 * guild copy and the global one. This removes only the guild copies.
 */
export async function clearGuildCommands(
  rest: Pick<REST, "get" | "put">,
  config: Pick<AppConfig, "clientId" | "guildId">,
): Promise<string> {
  if (!config.guildId) throw new Error("Set DISCORD_GUILD_ID to the test server whose command copies should be removed.");
  await assertTokenMatchesApplication(rest, config.clientId);
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: [] });
  return `Removed this application's test-server commands from guild ${config.guildId}. Global commands are unchanged.`;
}

export async function registerCommands(
  rest: Pick<REST, "get" | "put">,
  config: Pick<AppConfig, "clientId" | "guildId">,
  global: boolean,
): Promise<string> {
  // Never convert an incomplete local setup into a global bulk overwrite.
  if (!global && !config.guildId) {
    throw new Error("Set DISCORD_GUILD_ID to your test server ID. Global registration requires --global explicitly.");
  }
  if (global && config.guildId) {
    throw new Error("Global registration refused while DISCORD_GUILD_ID is set. Clear it only when intentionally releasing globally.");
  }

  await assertTokenMatchesApplication(rest, config.clientId);
  const route = config.guildId
    ? Routes.applicationGuildCommands(config.clientId, config.guildId)
    : Routes.applicationCommands(config.clientId);
  await rest.put(route, { body: commandData });
  return `Deployed ${commandData.length} commands ${config.guildId ? `to guild ${config.guildId}` : "globally"}.`;
}
