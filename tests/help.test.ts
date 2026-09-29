import { describe, expect, it } from "vitest";
import { buildHelpMessage } from "../src/discord/handlers.js";

function buttons(message: ReturnType<typeof buildHelpMessage>) {
  return message.components[0]!.toJSON().components.map((button) => ({
    label: "label" in button ? button.label : undefined,
    url: "url" in button ? button.url : undefined,
  }));
}

describe("/countdown-help", () => {
  it("links only the online countdown when no support or privacy URL is configured", () => {
    expect(buttons(buildHelpMessage({ siteBaseUrl: "https://example.test" })).map(({ label }) => label))
      .toEqual(["Open online countdown"]);
  });

  it("uses HTTPS for the online countdown even with older HTTP configuration", () => {
    expect(buttons(buildHelpMessage({ siteBaseUrl: "http://onlinealarmkur.com" }))[0]?.url)
      .toBe("https://onlinealarmkur.com/countdown/en/?utm_source=discord&utm_medium=bot&utm_campaign=help");
  });

  it("adds support and privacy links for App Directory users", () => {
    expect(buttons(buildHelpMessage({
      siteBaseUrl: "https://example.test",
      supportServerUrl: "https://discord.gg/example",
      privacyPolicyUrl: "https://example.test/privacy.html",
    }))).toEqual([
      { label: "Open online countdown", url: "https://example.test/countdown/en/?utm_source=discord&utm_medium=bot&utm_campaign=help" },
      { label: "Support", url: "https://discord.gg/example" },
      { label: "Privacy", url: "https://example.test/privacy.html" },
    ]);
  });

  it("never shows a past event date as the example", () => {
    const event = buildHelpMessage({ siteBaseUrl: "https://example.test" }).embeds[0]!.toJSON().fields!
      .find(({ name }) => name === "Event countdown")!.value;
    const year = Number(/when:(\d{4})-01-01 00:00/.exec(event)?.[1]);
    expect(year).toBeGreaterThan(new Date().getUTCFullYear());
  });
});
