import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({
  destroy: vi.fn(), close: vi.fn(), stop: vi.fn(), start: vi.fn(), bind: vi.fn(),
  drain: vi.fn().mockResolvedValue(undefined),
  guildIds: vi.fn((): string[] => []),
  deleteGuild: vi.fn((_guildId: string) => 0),
  clientHandlers: new Map<string, (...args: any[]) => void>(),
}));

vi.mock("discord.js", () => ({
  Client: class {
    channels = { cache: { sweep: () => 0 } };
    rest = { on: () => this.rest };
    once(event: string, listener: (...args: any[]) => void) { lifecycle.clientHandlers.set(event, listener); return this; }
    on(event: string, listener: (...args: any[]) => void) { lifecycle.clientHandlers.set(event, listener); return this; }
    login() { return Promise.resolve(); }
    destroy() { return lifecycle.destroy(); }
  },
  ChannelType: { DM: 1 },
  RESTEvents: { InvalidRequestWarning: "invalidRequestWarning" },
  Events: { ClientReady: "ready", GuildDelete: "guildDelete", ShardDisconnect: "shardDisconnect" },
  GatewayIntentBits: { Guilds: 1, GuildVoiceStates: 2 },
  Options: { cacheWithLimits: () => () => new Map(), DefaultMakeCacheSettings: {}, DefaultSweeperSettings: {} },
}));
vi.mock("../src/config.js", () => ({
  loadConfig: () => ({ databasePath: ":memory:", token: "fixture", clientId: "123456789012345678" }),
}));
vi.mock("../src/database.js", () => ({ CountdownDatabase: class {
  close() { lifecycle.close(); }
  bindApplication(applicationId: string) { lifecycle.bind(applicationId); }
  listGuildIds() { return lifecycle.guildIds(); }
  deleteGuildData(guildId: string) { return lifecycle.deleteGuild(guildId); }
} }));
vi.mock("../src/services/scheduler.js", () => ({ CountdownScheduler: class {
  start() { lifecycle.start(); }
  stop() { lifecycle.stop(); }
  drain() { return lifecycle.drain(); }
} }));
vi.mock("../src/discord/handlers.js", () => ({ installInteractionHandlers: () => ({
  stop: lifecycle.stop, drain: lifecycle.drain,
}) }));

const processHandlers = new Map<string | symbol, (...args: any[]) => void>();
let exit: ReturnType<typeof vi.spyOn>;

async function startEntrypoint(): Promise<void> {
  vi.resetModules();
  processHandlers.clear();
  lifecycle.clientHandlers.clear();
  await import("../src/index.js");
}

beforeEach(() => {
  for (const mock of [lifecycle.destroy, lifecycle.close, lifecycle.stop, lifecycle.start, lifecycle.bind, lifecycle.deleteGuild]) {
    mock.mockReset();
  }
  lifecycle.drain.mockReset().mockResolvedValue(undefined);
  lifecycle.guildIds.mockReset().mockReturnValue([]);
  vi.spyOn(process, "once").mockImplementation((event, listener) => {
    processHandlers.set(event, listener); return process;
  });
  exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("real entrypoint shutdown ordering", () => {
  it.each([false, true])("awaits client teardown before closing SQLite/exiting (failure=%s)", async (failure) => {
    let finish!: () => void;
    lifecycle.destroy.mockImplementation(() => new Promise<void>((resolve, reject) => {
      finish = () => failure ? reject(new Error("teardown failed")) : resolve();
    }));
    await startEntrypoint();
    expect(lifecycle.bind).toHaveBeenCalledWith("123456789012345678");
    processHandlers.get("SIGTERM")!();
    await vi.waitFor(() => expect(lifecycle.destroy).toHaveBeenCalledOnce());
    expect(lifecycle.close).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(failure ? 1 : 0));
    expect(lifecycle.close).toHaveBeenCalledOnce();
    expect(lifecycle.stop).toHaveBeenCalledTimes(2);
  });

  it("does not let a stuck delivery hold shutdown past the drain deadline", async () => {
    vi.useFakeTimers();
    lifecycle.drain.mockReturnValue(new Promise(() => undefined));
    lifecycle.destroy.mockResolvedValue(undefined);
    await startEntrypoint();
    processHandlers.get("SIGTERM")!();
    await vi.advanceTimersByTimeAsync(19_000);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(exit).toHaveBeenCalledWith(0);
    expect(lifecycle.close).toHaveBeenCalledOnce();
  });

  it("exits non-zero when Discord closes a shard permanently, so a supervisor notices", async () => {
    lifecycle.destroy.mockResolvedValue(undefined);
    await startEntrypoint();
    lifecycle.clientHandlers.get("shardDisconnect")!({ code: 4011 }, 0);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });
});

describe("server removal", () => {
  it("purges servers removed while offline, then starts the scheduler", async () => {
    lifecycle.guildIds.mockReturnValue(["kept", "departed"]);
    await startEntrypoint();
    lifecycle.clientHandlers.get("ready")!({
      user: { tag: "Countdown Bot#0001" },
      guilds: { cache: new Map([["kept", {}], ["outage", { available: false }]]) },
    });
    expect(lifecycle.deleteGuild.mock.calls).toEqual([["departed"]]);
    expect(lifecycle.start).toHaveBeenCalledOnce();
  });

  it("deletes a server's countdowns as soon as the bot is removed", async () => {
    await startEntrypoint();
    lifecycle.clientHandlers.get("guildDelete")!({ id: "removed" });
    expect(lifecycle.deleteGuild).toHaveBeenCalledWith("removed");
  });
});
