import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { loadConfig } from "./config.js";

export interface Diagnostic {
  name: string;
  status: "pass" | "fail" | "skip" | "warn";
  message: string;
}

export interface DiagnosticOptions {
  codeOnly?: boolean;
  environment?: NodeJS.ProcessEnv;
  nodeVersion?: string;
}

const localProbes = {
  async sqlite(): Promise<void> {
    const { CountdownDatabase } = await import("./database.js");
    const database = new CountdownDatabase(":memory:");
    try {
      const result = database.database.prepare("PRAGMA integrity_check").get();
      if (result?.integrity_check !== "ok") throw new Error("SQLite integrity check failed");
    } finally {
      database.close();
    }
  },
  async voice(): Promise<void> {
    // Importing the real voice package also loads its required DAVE library.
    // Encode actual PCM locally; never join a channel, open a socket, or play audio.
    const { createAudioResource, StreamType } = await import("@discordjs/voice");
    const { createChimePcm } = await import("./services/chime.js");
    const { XChaCha20Poly1305 } = await import("@stablelib/xchacha20poly1305");
    const cipher = new XChaCha20Poly1305(new Uint8Array(32));
    try {
      const nonce = new Uint8Array(24);
      const plaintext = new Uint8Array([1, 2, 3]);
      const decoded = cipher.open(nonce, cipher.seal(nonce, plaintext));
      if (!decoded || !Buffer.from(decoded).equals(Buffer.from(plaintext))) throw new Error("Cipher check failed");
    } finally {
      cipher.clean();
    }
    const resource = createAudioResource(Readable.from(createChimePcm("beep")), { inputType: StreamType.Raw });
    const timeout = setTimeout(() => resource.playStream.destroy(new Error("Encoder timed out")), 5_000);
    try {
      let packets = 0;
      for await (const packet of resource.playStream) {
        if (packet.length > 0) packets += 1;
      }
      if (packets === 0) throw new Error("Encoder returned no audio packets");
    } finally {
      clearTimeout(timeout);
      resource.playStream.destroy();
    }
  },
};

export async function runDiagnostics(
  options: DiagnosticOptions = {},
  probes = localProbes,
): Promise<Diagnostic[]> {
  const results: Diagnostic[] = [];
  const environment = options.environment ?? process.env;
  const [major = 0, minor = 0] = (options.nodeVersion ?? process.versions.node).split(".").map(Number);
  const supportedNode = major > 24 || (major === 24 && minor >= 21);
  results.push({ name: "Node.js", status: supportedNode ? "pass" : "fail", message: "Node.js 24.21.0 or later is required; use Node 24 LTS in production." });
  if (options.codeOnly) {
    results.push({ name: "Local configuration", status: "skip", message: "Code-only mode: credentials and database location were not checked." });
  } else {
    try {
      const missing = ["DISCORD_TOKEN", "DISCORD_CLIENT_ID"].filter((key) => !environment[key]?.trim());
      if (missing.length > 0) throw new Error(`Set ${missing.join(" and ")} in your local .env.`);
      const config = loadConfig(environment);
      results.push({ name: "Local configuration", status: "pass", message: "Required values and configuration formats are present; token validity is not checked offline." });
      results.push(config.guildId
        ? { name: "Registration scope", status: "pass", message: "A numeric test-server ID is configured; server access is not checked offline." }
        : { name: "Registration scope", status: "warn", message: "No test-server ID. Set DISCORD_GUILD_ID for testing. Global registration always requires --global." });
      results.push(config.supportServerUrl && config.privacyPolicyUrl
        ? { name: "Public links", status: "pass", message: "Support and Privacy links are set for /countdown-help." }
        : { name: "Public links", status: "warn", message: "Set SUPPORT_SERVER_URL and PRIVACY_POLICY_URL before the public release; /countdown-help omits their buttons until then." });
      try {
        if (config.databasePath === ":memory:") throw new Error("Non-persistent database");
        let path = resolve(config.databasePath);
        if (existsSync(path)) {
          if (!statSync(path).isFile()) throw new Error("Not a file");
          accessSync(path, constants.R_OK | constants.W_OK);
        }
        path = dirname(path);
        while (!existsSync(path)) path = dirname(path);
        if (!statSync(path).isDirectory()) throw new Error("Not a directory");
        accessSync(path, constants.W_OK | constants.X_OK);
        results.push({ name: "Database location", status: "pass", message: "Persistent location is accessible. No file was created or opened; disk space and write success are not verified." });
      } catch {
        results.push({ name: "Database location", status: "fail", message: "DATABASE_PATH must point to a persistent file with an accessible, writable parent directory (including SQLite WAL files)." });
      }
    } catch (error) {
      // Only our configuration validators reach this branch; they report the
      // field name, never the supplied value. Dependency errors below are generic.
      results.push({ name: "Local configuration", status: "fail", message: error instanceof Error ? error.message : "Invalid configuration." });
    }
  }
  for (const [name, probe] of [["SQLite migrations", probes.sqlite], ["Voice dependencies", probes.voice]] as const) {
    try {
      await probe();
      results.push({ name, status: "pass", message: name === "SQLite migrations" ? "Schema and integrity checked in memory only." : "DAVE loaded; PCM encoded to Opus; XChaCha20 round-trip passed. No sound was played." });
    } catch {
      results.push({ name, status: "fail", message: "Local runtime check failed. Use Node.js 24.21.0 or later and reinstall with npm ci --ignore-scripts; run npm test for details." });
    }
  }
  return results;
}
