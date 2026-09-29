import { describe, expect, it } from "vitest";
import { literalDiscordText, singleLineDiscordText } from "../src/discord/literal-text.js";

describe("literalDiscordText", () => {
  it("neutralizes links, layout syntax, Discord tokens, and line breaks", () => {
    const value = [
      "[Claim prize](https://evil.example)",
      "# heading > quote - list ||spoiler|| ```code```",
      "<@123> <#456> <t:123:R> @everyone www.evil.example",
    ].join("\n");
    const rendered = literalDiscordText(value);

    expect(rendered).not.toContain("\n");
    expect(rendered).not.toContain("](https://");
    expect(rendered).not.toContain("https://");
    expect(rendered).not.toContain("www.evil.example");
    expect(rendered).not.toContain("<@123>");
    expect(rendered).not.toContain("<#456>");
    expect(rendered).not.toContain("<t:123:R>");
    expect(rendered).not.toContain("@everyone");
    expect(rendered).toContain("Claim prize");
  });

  it("preserves ordinary Unicode labels and truncates without splitting emoji", () => {
    expect(literalDiscordText("  Game night 🧙‍♀️  ")).toBe("Game night 🧙‍♀️");
    expect(literalDiscordText("😀😀", 5)).toBe("😀😀");
    expect(literalDiscordText("😀😀", 3)).toBe("😀");
  });

  it("bounds the escaped output and rejects unsafe limits", () => {
    const rendered = literalDiscordText("*".repeat(100), 25);
    expect(rendered.length).toBeLessThanOrEqual(25);
    expect(literalDiscordText("*", 1)).toBe("C");
    expect(literalDiscordText("", 4)).toBe("Coun");
    expect(() => literalDiscordText("x", 0)).toThrow(RangeError);
    expect(() => literalDiscordText("x", 1.5)).toThrow(RangeError);
  });

  it("creates plain, single-line autocomplete text without splitting Unicode", () => {
    expect(singleLineDiscordText("  Launch\nnight 😀😀  ", 17)).toBe("Launch night 😀😀");
    expect(singleLineDiscordText("😀😀", 3)).toBe("😀");
    expect(() => singleLineDiscordText("x", 0)).toThrow(RangeError);
  });

  it("removes bidi controls and refuses invisible-only labels", () => {
    const reordered = literalDiscordText("safe \u202Eevil.example\u202C tail");
    expect(reordered).not.toContain("\u202E");
    expect(reordered).not.toContain("\u202C");
    expect(literalDiscordText("\u200B\u2060")).toBe("Countdown");
    expect(literalDiscordText("🧙‍♀️")).toBe("🧙‍♀️");
  });

  it("refuses compatibility blanks and interlinear annotation controls", () => {
    expect(literalDiscordText("\u2800\u3164\uffa0")).toBe("Countdown");
    expect(literalDiscordText("\ufff9\ufffa\ufffb")).toBe("Countdown");
    expect(literalDiscordText("Launch\ufff9hidden\ufffb")).toBe("Launchhidden");
  });

  it("never leaves half of a joined emoji when a limit lands inside its grapheme", () => {
    expect(singleLineDiscordText(`${"a".repeat(79)}👩‍💻`, 82)).toBe("a".repeat(79));
    expect(literalDiscordText(`${"a".repeat(79)}👩‍💻`, 82)).toBe("a".repeat(79));
  });

  it("keeps an emoji subdivision flag but rejects standalone invisible tag characters", () => {
    const england = "🏴󠁧󠁢󠁥󠁮󠁧󠁿";
    expect(literalDiscordText(england)).toBe(england);
    expect(literalDiscordText("\u{e0067}\u{e007f}")).toBe("Countdown");
  });
});
