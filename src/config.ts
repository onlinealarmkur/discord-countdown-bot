import "dotenv/config";
import { IANAZone } from "luxon";
import { DEFAULT_COUNTDOWN_LIMITS, type CountdownLimits } from "./domain/limits.js";

export interface AppConfig {
  token: string;
  clientId: string;
  guildId?: string;
  databasePath: string;
  siteBaseUrl: string;
  defaultTimezone: string;
  countdownLimits?: CountdownLimits;
  supportServerUrl?: string;
  privacyPolicyUrl?: string;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function configuredId(environment: NodeJS.ProcessEnv, name: string): string {
  const value = required(environment, name);
  if (!/^[1-9]\d{0,19}$/.test(value) || BigInt(value) > 18_446_744_073_709_551_615n) {
    throw new Error(`${name} must be a Discord numeric ID copied with Developer Mode, not a name or invite URL`);
  }
  return value;
}

function configuredTimezone(environment: NodeJS.ProcessEnv): string {
  const timezone = environment.DEFAULT_TIMEZONE?.trim() || "UTC";
  if (!IANAZone.isValidZone(timezone)) {
    throw new Error(
      "DEFAULT_TIMEZONE must be a valid IANA timezone such as Europe/Madrid or America/New_York",
    );
  }
  return timezone;
}

function configuredSiteBaseUrl(environment: NodeJS.ProcessEnv): string {
  const value = environment.SITE_BASE_URL?.trim() || "https://onlinealarmkur.com";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("SITE_BASE_URL must be an absolute HTTP or HTTPS origin");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:")
    || url.username
    || url.password
    || (url.pathname !== "/" && url.pathname !== "")
    || url.search
    || url.hash
  ) {
    throw new Error("SITE_BASE_URL must be an absolute HTTP or HTTPS origin");
  }
  return url.origin;
}

function configuredCountdownLimits(environment: NodeJS.ProcessEnv): CountdownLimits {
  const integer = (name: string, fallback: number, ceiling: number): number => {
    const value = environment[name]?.trim();
    if (!value) return fallback;
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > ceiling) {
      throw new Error(`${name} must be an integer between 1 and ${ceiling}`);
    }
    return Number(value);
  };
  return {
    perGuild: integer("MAX_ACTIVE_COUNTDOWNS_PER_GUILD", DEFAULT_COUNTDOWN_LIMITS.perGuild, 100_000),
    total: integer("MAX_ACTIVE_COUNTDOWNS_TOTAL", DEFAULT_COUNTDOWN_LIMITS.total, 1_000_000),
    perUser: integer("MAX_ACTIVE_COUNTDOWNS_PER_USER", DEFAULT_COUNTDOWN_LIMITS.perUser, 1_000),
    creationsPerMinute: integer("MAX_CREATIONS_PER_MINUTE", DEFAULT_COUNTDOWN_LIMITS.creationsPerMinute, 60),
  };
}

function optionalPublicUrl(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = environment[name]?.trim();
  if (!value) return undefined;
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (!url || url.protocol !== "https:" || url.username || url.password || url.toString().length > 512) {
    throw new Error(`${name} must be an absolute https:// URL`);
  }
  return url.toString();
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const supportServerUrl = optionalPublicUrl(environment, "SUPPORT_SERVER_URL");
  const privacyPolicyUrl = optionalPublicUrl(environment, "PRIVACY_POLICY_URL");
  return {
    ...loadRegistrationConfig(environment),
    databasePath: environment.DATABASE_PATH?.trim() || "./data/countdowns.db",
    siteBaseUrl: configuredSiteBaseUrl(environment),
    defaultTimezone: configuredTimezone(environment),
    countdownLimits: configuredCountdownLimits(environment),
    ...(supportServerUrl ? { supportServerUrl } : {}),
    ...(privacyPolicyUrl ? { privacyPolicyUrl } : {}),
  };
}

export function loadRegistrationConfig(environment: NodeJS.ProcessEnv = process.env): Pick<AppConfig, "token" | "clientId" | "guildId"> {
  const token = required(environment, "DISCORD_TOKEN");
  const clientId = configuredId(environment, "DISCORD_CLIENT_ID");
  const guildId = environment.DISCORD_GUILD_ID?.trim()
    ? configuredId(environment, "DISCORD_GUILD_ID") : undefined;
  return {
    token,
    clientId,
    ...(guildId ? { guildId } : {}),
  };
}
