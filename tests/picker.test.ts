import { describe, expect, it } from "vitest";
import { buildPresetPicker } from "../src/discord/handlers.js";

describe("quick countdown picker", () => {
  it("defaults to an explicit no-beep alert and one-tap durations", () => {
    const picker = buildPresetPicker("user-1");
    expect(picker.content).toContain("Text only (no beep)");
    const buttons = picker.components[0]?.toJSON().components ?? [];
    expect(buttons.map((button) => "label" in button ? button.label : null)).toEqual([
      "5 minutes",
      "10 minutes",
      "30 minutes",
      "1 hour",
      "Custom…",
    ]);
    expect(buttons[0] && "custom_id" in buttons[0] ? buttons[0].custom_id : null)
      .toBe("countdown:preset:user-1:silent:5m");
  });

  it("carries the chosen voice alert into every creation button", () => {
    const picker = buildPresetPicker("user-1", "beep");
    const buttons = picker.components[0]?.toJSON().components ?? [];
    expect(buttons.every((button) =>
      "custom_id" in button && button.custom_id?.includes(":beep:"),
    )).toBe(true);

    const menu = picker.components[1]?.toJSON().components[0];
    const options = menu && "options" in menu ? menu.options : [];
    expect(options.find((option) => option.value === "beep")?.default).toBe(true);
    expect(options.find((option) => option.value === "beep")?.label).toBe("Text + Beep");
    expect(options.find((option) => option.value === "silent")?.label).toBe("Text only (no beep)");
  });

  it.each(["silent", "beep", "bell", "urgent"] as const)(
    "keeps the %s choice in preset and Custom button IDs",
    (sound) => {
      const picker = buildPresetPicker("user-1", sound);
      const buttons = picker.components[0]?.toJSON().components ?? [];
      expect(buttons).toHaveLength(5);
      expect(buttons.every((button) =>
        "custom_id" in button && button.custom_id?.includes(`:${sound}:`),
      )).toBe(true);
    },
  );
});
