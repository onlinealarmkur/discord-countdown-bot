import { mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDiagnostics } from "../src/diagnostics.js";

const directories: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), "countdown-doctor-"));
  directories.push(path);
  return path;
}
function probes() { return { sqlite: vi.fn().mockResolvedValue(undefined), voice: vi.fn().mockResolvedValue(undefined) }; }
const environment = { DISCORD_TOKEN: "PRIVATE_SENTINEL_NEVER_PRINT", DISCORD_CLIENT_ID: "123456789012345678" };

afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("offline setup checks", () => {
  it("reports missing local credentials without inheriting the process environment", async () => {
    const results = await runDiagnostics({ environment: {} }, probes());
    expect(results).toContainEqual(expect.objectContaining({ name: "Local configuration", status: "fail", message: "Set DISCORD_TOKEN and DISCORD_CLIENT_ID in your local .env." }));
  });

  it("validates configuration without printing credentials or creating the production database", async () => {
    const path = join(directory(), "data", "countdowns.db");
    const results = await runDiagnostics({ environment: {
      ...environment,
      DISCORD_GUILD_ID: "123456789012345679",
      DATABASE_PATH: path,
      SUPPORT_SERVER_URL: "https://discord.gg/example",
      PRIVACY_POLICY_URL: "https://example.test/privacy.html",
    } }, probes());
    expect(results.every(({ status }) => status === "pass")).toBe(true);
    expect(JSON.stringify(results)).not.toContain(environment.DISCORD_TOKEN);
    expect(existsSync(join(path, ".."))).toBe(false);
  });

  it("warns while the public support and privacy links are unset", async () => {
    const results = await runDiagnostics({ environment: { ...environment, DATABASE_PATH: join(directory(), "bot.db") } }, probes());
    expect(results).toContainEqual(expect.objectContaining({ name: "Public links", status: "warn" }));
  });

  it("warns instead of silently choosing global registration", async () => {
    const results = await runDiagnostics({ environment: { ...environment, DATABASE_PATH: join(directory(), "bot.db") } }, probes());
    expect(results).toContainEqual(expect.objectContaining({ name: "Registration scope", status: "warn" }));
  });

  it.each([":memory:", "directory", "file-parent"])("rejects a non-persistent or unusable database location: %s", async (kind) => {
    const root = directory();
    const file = join(root, "not-a-directory");
    writeFileSync(file, "fixture");
    const path = kind === ":memory:" ? kind : kind === "directory" ? root : join(file, "bot.db");
    const results = await runDiagnostics({ environment: { ...environment, DATABASE_PATH: path } }, probes());
    expect(results).toContainEqual(expect.objectContaining({ name: "Database location", status: "fail" }));
  });

  it("does not echo a supplied invalid configuration value", async () => {
    const results = await runDiagnostics({ environment: { ...environment, SITE_BASE_URL: environment.DISCORD_TOKEN } }, probes());
    expect(results).toContainEqual(expect.objectContaining({ name: "Local configuration", status: "fail" }));
    expect(JSON.stringify(results)).not.toContain(environment.DISCORD_TOKEN);
  });

  it("reports dependency failures without dumping arbitrary exception contents", async () => {
    const local = probes();
    local.voice.mockRejectedValue(new Error(environment.DISCORD_TOKEN));
    const results = await runDiagnostics({ codeOnly: true, environment: {} }, local);
    expect(results).toContainEqual(expect.objectContaining({ name: "Voice dependencies", status: "fail" }));
    expect(JSON.stringify(results)).not.toContain(environment.DISCORD_TOKEN);
  });

  it.each(["22.18.0", "24.20.0"])("does not claim unsupported Node %s or skipped configuration are ready", async (nodeVersion) => {
    const results = await runDiagnostics({ codeOnly: true, nodeVersion, environment: {} }, probes());
    expect(results).toContainEqual(expect.objectContaining({ name: "Node.js", status: "fail" }));
    expect(results).toContainEqual(expect.objectContaining({ name: "Local configuration", status: "skip" }));
  });

  it("exercises the installed SQLite schema, DAVE, Opus and XChaCha20 entirely offline", async () => {
    const results = await runDiagnostics({ codeOnly: true, environment: {} });
    expect(results.filter(({ status }) => status === "fail")).toEqual([]);
    expect(results.filter(({ status }) => status === "pass").map(({ name }) => name)).toEqual(["Node.js", "SQLite migrations", "Voice dependencies"]);
  }, 30_000);
});
