import { Routes, type REST } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { clearGuildCommands, registerCommands, registrationMode } from "../src/discord/registration.js";
import { commandData } from "../src/discord/commands.js";

const clientId = "123456789012345678";
const guildId = "123456789012345679";
function transport(applicationId = clientId) {
  const get = vi.fn().mockResolvedValue({ id: applicationId });
  const put = vi.fn().mockResolvedValue([]);
  return { get, put, rest: { get, put } as unknown as Pick<REST, "get" | "put"> };
}

describe("safe command registration", () => {
  it("defaults to guild registration and separates offline printing from global writes", () => {
    expect(registrationMode([])).toBe("guild");
    expect(registrationMode(["--print"])).toBe("print");
    expect(registrationMode(["--global"])).toBe("global");
    expect(registrationMode(["--clear-guild"])).toBe("clear-guild");
    expect(registrationMode(["--help"])).toBe("help");
    expect(registrationMode(["-h"])).toBe("help");
  });

  it.each([["--gloabl"], ["--print", "--global"], ["--global", "--global"]])("refuses ambiguous arguments %j", (...args) => {
    expect(() => registrationMode(args)).toThrow("Use no flags");
  });

  it("refuses missing guild configuration without making any request", async () => {
    const api = transport();
    await expect(registerCommands(api.rest, { clientId }, false)).rejects.toThrow("Set DISCORD_GUILD_ID");
    expect(api.get).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
  });

  it("refuses conflicting global and guild scope before any request", async () => {
    const api = transport();
    await expect(registerCommands(api.rest, { clientId, guildId }, true)).rejects.toThrow("Global registration refused");
    expect(api.get).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
  });

  it("checks the token's actual application before replacing test-server commands", async () => {
    const api = transport();
    await expect(registerCommands(api.rest, { clientId, guildId }, false)).resolves.toBe(`Deployed 4 commands to guild ${guildId}.`);
    expect(api.get).toHaveBeenCalledExactlyOnceWith(Routes.oauth2CurrentApplication());
    expect(api.put).toHaveBeenCalledExactlyOnceWith(Routes.applicationGuildCommands(clientId, guildId), { body: commandData });
    expect(api.get.mock.invocationCallOrder[0]).toBeLessThan(api.put.mock.invocationCallOrder[0]!);
  });

  it("only writes globally with the explicit mode and no guild configured", async () => {
    const api = transport();
    await expect(registerCommands(api.rest, { clientId }, true)).resolves.toBe("Deployed 4 commands globally.");
    expect(api.put).toHaveBeenCalledExactlyOnceWith(Routes.applicationCommands(clientId), { body: commandData });
  });

  it("does not mutate another application when the configured ID mismatches the token", async () => {
    const api = transport("123456789012345680");
    await expect(registerCommands(api.rest, { clientId, guildId }, false)).rejects.toThrow("different applications");
    expect(api.put).not.toHaveBeenCalled();
  });

  it("does not overwrite commands when authentication or identity lookup fails", async () => {
    const api = transport();
    api.get.mockRejectedValue(new Error("401 Unauthorized"));
    await expect(registerCommands(api.rest, { clientId, guildId }, false)).rejects.toThrow("401 Unauthorized");
    expect(api.put).not.toHaveBeenCalled();
  });

  it("propagates a failed registration instead of reporting success", async () => {
    const api = transport();
    api.put.mockRejectedValue(new Error("Missing Access"));
    await expect(registerCommands(api.rest, { clientId, guildId }, false)).rejects.toThrow("Missing Access");
  });

  it("removes only the test-server copies after a global release, after checking identity", async () => {
    const api = transport();
    await expect(clearGuildCommands(api.rest, { clientId, guildId })).resolves.toContain("Global commands are unchanged");
    expect(api.put).toHaveBeenCalledExactlyOnceWith(Routes.applicationGuildCommands(clientId, guildId), { body: [] });
    expect(api.get.mock.invocationCallOrder[0]).toBeLessThan(api.put.mock.invocationCallOrder[0]!);
  });

  it("never clears without a guild or with a mismatched token", async () => {
    const missing = transport();
    await expect(clearGuildCommands(missing.rest, { clientId })).rejects.toThrow("Set DISCORD_GUILD_ID");
    expect(missing.get).not.toHaveBeenCalled();
    const mismatched = transport("123456789012345680");
    await expect(clearGuildCommands(mismatched.rest, { clientId, guildId })).rejects.toThrow("different applications");
    expect(mismatched.put).not.toHaveBeenCalled();
  });
});
