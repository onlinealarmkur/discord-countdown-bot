import { describe, expect, it } from "vitest";
import { commandData } from "../src/discord/commands.js";

describe("Discord command schema", () => {
  it("exposes a countdown-only command surface", () => {
    expect(commandData.map(({ name }) => name)).toEqual([
      "countdown",
      "countdowns",
      "countdown-manage",
      "countdown-help",
    ]);
  });

  it("keeps the primary countdown surface short", () => {
    const countdown = commandData.find(({ name }) => name === "countdown");
    expect(countdown?.options?.map(({ name }) => name)).toEqual([
      "when",
      "label",
      "timezone",
      "sound",
      "remind_before",
      "notify_role",
    ]);
  });

  it("allows a no-input command to open quick preset buttons", () => {
    const options = commandData.find(({ name }) => name === "countdown")?.options ?? [];
    const when = options.find(({ name }) => name === "when");
    expect(when?.required).not.toBe(true);
    expect(when && "autocomplete" in when ? when.autocomplete : false).toBe(true);
  });

  it("does not register the occupied timer command", () => {
    expect(commandData.map(({ name }) => name)).not.toContain("timer");
  });

  it("provides a recovery command for deleted or stale countdown cards", () => {
    const manage = commandData.find(({ name }) => name === "countdown-manage");
    expect(manage?.options?.map(({ name }) => name)).toEqual(["countdown", "action"]);
    const countdown = manage?.options?.find(({ name }) => name === "countdown");
    expect(countdown && "autocomplete" in countdown ? countdown.autocomplete : false).toBe(true);
  });

  it("offers an explicit text-only option alongside voice alerts", () => {
    const countdown = commandData.find(({ name }) => name === "countdown");
    const sound = countdown?.options?.find(({ name }) => name === "sound");
    const choices = sound && "choices" in sound ? sound.choices : [];
    expect(choices?.map(({ value }) => value)).toEqual(["silent", "beep", "bell", "urgent"]);
    expect(choices?.[0]?.name).toContain("no voice sound");
    expect(choices?.slice(1).every(({ name }) => name.startsWith("Text +"))).toBe(true);
  });

  it("contains no Pomodoro product surface", () => {
    expect(JSON.stringify(commandData).toLowerCase()).not.toContain("pomodoro");
  });
});
