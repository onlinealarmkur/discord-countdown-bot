import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

function ignored(paths: string[]): string[] {
  const result = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], {
    cwd: root, input: `${paths.join("\n")}\n`, encoding: "utf8", timeout: 10_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) throw new Error("git check-ignore failed");
  return result.stdout.trim().split("\n").filter(Boolean);
}

describe("public repository hygiene", () => {
  it("ignores secrets, runtime state, backups, generated output and local-only notes", () => {
    const paths = [
      ".env", ".env.production", "deploy/production.env", "nested/.env.local",
      "deploy/production.env.saved", "nested/.env.example", ".envrc", ".direnv/local",
      "secrets/token.txt", ".secrets/credentials.json", ".npmrc", ".netrc", ".git-credentials",
      "data/countdowns.db", "backups/monday.db", "custom/countdowns.db-journal",
      "custom/countdowns-mon.db.partial", "custom/countdowns-mon.db.partial-wal",
      "custom/countdowns-mon.db.partial-shm", "custom/countdowns-mon.db.partial-journal",
      "custom/countdowns.sqlite3", "custom/countdowns.sqlite3-wal", "custom/countdowns.sqlite3-shm",
      "custom/countdowns.sqlite-journal", "server.key", "server.pem", "logs/service.log",
      "custom/timers.sqlite.partial-wal", "custom/timers.sqlite3.partial-journal",
      "custom/slack-installations.enc", ".ssh/config", "keys/id_ed25519", "keys/id_rsa",
      "keys/id_ecdsa", "keys/id_dsa", "server.ppk", "server.keystore", "server.jks",
      "age-key.txt", "age-identity-backup.txt", "apps-2026-09-28.tar.age", "countdown-backups/readme.txt",
      "snapshots/server.img", "transfer.tar", "transfer.tar.gz", "transfer.tar.xz",
      "transfer.tar.bz2", "transfer.tgz", "transfer.zip", "countdowns.sql.gz",
      "report.20260928.123456.1234.0.001.json", "Heap.heapsnapshot", "Heap.heapprofile",
      "CPU.cpuprofile", "core", "core.1234", ".railway/project.json",
      "npm-debug.log", "node_modules/local/index.js", "dist/src/index.js", "coverage/index.html",
      ".vscode/settings.json", "assets/icon/__pycache__/tile.cpython-313.pyc", ".venv/bin/python",
      "plans/review.md", "advisor-plans/review.md", ".codex/local.json", ".DS_Store",
      "AGENTS.md", "CLAUDE.md", "GEMINI.md", ".agents/local.md", ".cursor/settings.json",
      ".continue/config.json", ".windsurf/rules.md", ".claude/local.json", "sandbox/notes.txt",
      "deploy/countdown-bot.service", "deploy/digitalocean-setup.sh", "docs/discord-launch.md",
      "publishing/README.md", "publishing/media/banner.png", "publishing/slack-next-steps.txt",
      "publishing/privacy-policy-additions-en-tr.txt", "legal/privacy.md", "site/icon.png",
      "private/server-notes.txt", "assets/generate-icon.py", "assets/icon/tile.py", "assets/README.md",
    ];
    expect(ignored(paths)).toEqual(paths);
  });

  it("keeps the configuration template, source, tests, CI and final icons publishable", () => {
    expect(ignored([
      ".env.example", "package-lock.json", "README.md", "CONTRIBUTING.md", "LICENSE", "SECURITY.md",
      "src/index.ts", "tests/fixtures.ts", ".github/workflows/ci.yml",
      "assets/countdown-bot-icon.svg", "assets/countdown-bot-icon.png", "scripts/capacity-benchmark.mjs",
      "src/migrations/001.sql", "tests/__snapshots__/example.snap",
    ])).toEqual([]);
  });

  it("has no broken local Markdown destinations in the public documentation", () => {
    const files = ["README.md", "CONTRIBUTING.md", "SECURITY.md"];
    const broken: string[] = [];
    for (const file of files) {
      const source = readFileSync(join(root, file), "utf8");
      for (const match of source.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = match[1]!;
        if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(target)) continue;
        const path = target.split("#")[0]!.split("?")[0]!;
        const resolved = resolve(root, dirname(file), decodeURIComponent(path));
        if (!existsSync(resolved) || ignored([resolved]).length > 0) broken.push(`${file}: ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("does not put private credentials in the public configuration template", () => {
    const template = readFileSync(join(root, ".env.example"), "utf8");
    for (const name of ["DISCORD_TOKEN", "DISCORD_CLIENT_ID", "DISCORD_GUILD_ID"]) {
      const value = template.match(new RegExp(`^${name}=(.*)$`, "m"));
      expect(value?.[1]?.trim()).toBe("");
    }
  });

  it("does not track private operational files even if force-added", () => {
    const result = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(0);
    const tracked = result.stdout.split("\0").filter(Boolean);
    expect(ignored(tracked)).toEqual([]);
  });
});
