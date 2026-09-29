import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("documented development entrypoint", () => {
  it("loads the real source imports and stops at missing configuration, before any network or database access", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      scripts: { dev: string };
    };
    const [binary, ...args] = manifest.scripts.dev.split(" ");
    expect(binary).toBe("node");
    expect(args).toContain("--watch");
    const env: NodeJS.ProcessEnv = { ...process.env, DOTENV_CONFIG_PATH: "/dev/null" };
    delete env.DISCORD_TOKEN;
    delete env.DISCORD_CLIENT_ID;
    delete env.DISCORD_GUILD_ID;
    // Remove only watch so the exact configured loader/entrypoint exits once.
    const result = spawnSync(process.execPath, args.filter((arg) => arg !== "--watch"), {
      cwd: new URL("..", import.meta.url), env, encoding: "utf8", timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Missing required environment variable: DISCORD_TOKEN");
    expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
  }, 20_000);
});

describe("offline operational entrypoints", () => {
  const env: NodeJS.ProcessEnv = { ...process.env, DOTENV_CONFIG_PATH: "/dev/null" };
  delete env.DISCORD_TOKEN;
  delete env.DISCORD_CLIENT_ID;
  delete env.DISCORD_GUILD_ID;

  it("prints the real command schema without credentials or registration", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/register-commands.ts", "--print"], {
      cwd: new URL("..", import.meta.url), env, encoding: "utf8", timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).map(({ name }: { name: string }) => name)).toEqual([
      "countdown", "countdowns", "countdown-manage", "countdown-help",
    ]);
  }, 20_000);

  it.each([false, true])("doctor returns a truthful exit status without credentials (codeOnly=%s)", (codeOnly) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/doctor.ts", ...(codeOnly ? ["--code-only"] : [])], {
      cwd: new URL("..", import.meta.url), env, encoding: "utf8", timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(codeOnly ? 0 : 1);
    expect(result.stdout).toContain("(offline): no Discord requests");
    expect(result.stdout).toContain("PASS Voice dependencies");
    expect(result.stdout).toContain(codeOnly ? "SKIP Local configuration" : "FAIL Local configuration");
  }, 20_000);
});
