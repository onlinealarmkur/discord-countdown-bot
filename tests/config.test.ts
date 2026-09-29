import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, loadRegistrationConfig } from "../src/config.js";

const environmentKeys = [
  "DISCORD_TOKEN",
  "DISCORD_CLIENT_ID",
  "DISCORD_GUILD_ID",
  "DATABASE_PATH",
  "SITE_BASE_URL",
  "DEFAULT_TIMEZONE",
  "SUPPORT_SERVER_URL",
  "PRIVACY_POLICY_URL",
  "MAX_ACTIVE_COUNTDOWNS_PER_GUILD",
  "MAX_ACTIVE_COUNTDOWNS_TOTAL",
  "MAX_ACTIVE_COUNTDOWNS_PER_USER",
  "MAX_CREATIONS_PER_MINUTE",
] as const;

const originalEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));

beforeEach(() => {
  for (const key of environmentKeys) delete process.env[key];
  process.env.DISCORD_TOKEN = "test-token";
  process.env.DISCORD_CLIENT_ID = "123456789012345678";
});

afterEach(() => {
  for (const key of environmentKeys) {
    const original = originalEnvironment.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

describe("loadConfig", () => {
  it.each(["DISCORD_CLIENT_ID", "DISCORD_GUILD_ID"])("validates %s before using it in API routes", (key) => {
    for (const value of ["test-server", "https://discord.gg/example", "1/commands", "0", "-1", "01", "1e18", "18446744073709551616"]) {
      process.env[key] = value;
      expect(() => loadConfig()).toThrow(`${key} must be a Discord numeric ID`);
      expect(() => loadRegistrationConfig()).toThrow(`${key} must be a Discord numeric ID`);
    }
  });

  it("preserves IDs without rounding and trims guild configuration", () => {
    process.env.DISCORD_GUILD_ID = "  123456789012345679  ";
    expect(loadConfig().guildId).toBe("123456789012345679");
  });

  it("can validate an isolated environment without inheriting credentials", () => {
    expect(() => loadConfig({})).toThrow("Missing required environment variable: DISCORD_TOKEN");
    expect(loadRegistrationConfig({ DISCORD_TOKEN: "fixture", DISCORD_CLIENT_ID: "123456789012345678" }).guildId).toBeUndefined();
  });

  it("uses UTC when no default timezone is configured", () => {
    expect(loadConfig().defaultTimezone).toBe("UTC");
  });

  it("trims and accepts a valid IANA default timezone", () => {
    process.env.DEFAULT_TIMEZONE = "  Europe/Madrid\t";
    expect(loadConfig().defaultTimezone).toBe("Europe/Madrid");
  });

  it.each(["Mars/Olympus", "UTC+02:00", "Europe / Madrid", "\u200bUTC"])(
    "rejects invalid DEFAULT_TIMEZONE=%s at startup",
    (timezone) => {
      process.env.DEFAULT_TIMEZONE = timezone;
      expect(() => loadConfig()).toThrow("DEFAULT_TIMEZONE must be a valid IANA timezone");
    },
  );

  it("normalizes a valid site origin", () => {
    process.env.SITE_BASE_URL = "  https://example.test/  ";
    expect(loadConfig().siteBaseUrl).toBe("https://example.test");
  });

  it.each([
    "not a URL",
    "ftp://example.test",
    "https://user:password@example.test",
    "https://example.test/countdown",
    "https://example.test?campaign=wrong",
    "https://example.test#fragment",
  ])("rejects unsafe or ambiguous SITE_BASE_URL=%s at startup", (siteBaseUrl) => {
    process.env.SITE_BASE_URL = siteBaseUrl;
    expect(() => loadConfig()).toThrow("SITE_BASE_URL must be an absolute HTTP or HTTPS origin");
  });
});

describe("optional public links", () => {
  it("omits unset links and accepts https URLs", () => {
    expect(loadConfig()).not.toHaveProperty("supportServerUrl");
    process.env.SUPPORT_SERVER_URL = "https://discord.gg/example";
    process.env.PRIVACY_POLICY_URL = "https://example.github.io/bot/privacy.html";
    expect(loadConfig()).toMatchObject({
      supportServerUrl: "https://discord.gg/example",
      privacyPolicyUrl: "https://example.github.io/bot/privacy.html",
    });
  });

  it.each(["discord.gg/example", "http://discord.gg/example", "https://user:pass@example.com/"])(
    "rejects %s without echoing it",
    (value) => {
      process.env.SUPPORT_SERVER_URL = value;
      expect(() => loadConfig()).toThrow("SUPPORT_SERVER_URL must be an absolute https:// URL");
    },
  );
});

describe("countdown capacity configuration", () => {
  it("uses provisional inventory bounds and separate per-member spam guards", () => {
    expect(loadConfig().countdownLimits).toEqual({ perGuild: 5000, total: 10000, perUser: 10, creationsPerMinute: 5 });
  });
  it("reads trimmed operator overrides", () => {
    process.env.MAX_ACTIVE_COUNTDOWNS_PER_GUILD = " 2000 ";
    process.env.MAX_ACTIVE_COUNTDOWNS_TOTAL = " 25000 ";
    process.env.MAX_ACTIVE_COUNTDOWNS_PER_USER = "20";
    process.env.MAX_CREATIONS_PER_MINUTE = "8";
    expect(loadConfig().countdownLimits).toEqual({ perGuild: 2000, total: 25000, perUser: 20, creationsPerMinute: 8 });
  });
  it.each(["0", "-1", "1.5", "Infinity", "1e3", "100001", "9007199254740992"])("rejects an invalid guild capacity %s", (value) => {
    process.env.MAX_ACTIVE_COUNTDOWNS_PER_GUILD = value;
    expect(() => loadConfig()).toThrow("MAX_ACTIVE_COUNTDOWNS_PER_GUILD must be an integer");
  });
  it.each(["0", "-1", "1.5", "Infinity", "1e6", "1000001"])("rejects an invalid global capacity %s", (value) => {
    process.env.MAX_ACTIVE_COUNTDOWNS_TOTAL = value;
    expect(() => loadConfig()).toThrow("MAX_ACTIVE_COUNTDOWNS_TOTAL must be an integer");
  });
});
