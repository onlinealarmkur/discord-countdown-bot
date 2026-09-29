import { describe, expect, it } from "vitest";
import {
  buildCountdownDestinationUrl,
  buildOnlineCountdownLandingUrl,
  buildOnlineCountdownUrl,
} from "../src/domain/links.js";
import { countdown } from "./fixtures.js";

function decodedCountdown(url: URL) {
  // The website first decodes the entire fragment, then reads its parameters.
  const fragment = decodeURIComponent(url.hash.slice(1));
  const separator = fragment.indexOf("&");
  return {
    fragment,
    deadline: fragment.slice(0, separator),
    parameters: new URLSearchParams(fragment.slice(separator + 1)),
  };
}

describe("countdown website deep links", () => {
  it("builds an exact UTC countdown with attribution", () => {
    const url = new URL(
      buildOnlineCountdownUrl("https://onlinealarmkur.com", Date.UTC(2026, 11, 31, 23), "Launch night"),
    );
    expect(url.pathname).toBe("/countdown/en/");
    const { deadline, parameters } = decodedCountdown(url);
    expect(deadline).toBe("2026-12-31T23:00:00");
    expect(parameters.get("tz")).toBe("UTC");
    expect(parameters.get("title")).toBe("Launch night");
    expect(url.searchParams.get("utm_source")).toBe("discord");
    expect(url.searchParams.get("utm_medium")).toBe("bot");
  });

  it("matches the website's fully encoded fragment, preserving seconds and Unicode titles", () => {
    const url = new URL(buildOnlineCountdownUrl(
      "https://onlinealarmkur.com",
      Date.UTC(2026, 8, 27, 12, 33, 59),
      "Geri sayım",
    ));
    expect(url.hash).toBe("#2026-09-27T12%3A33%3A59%26tz%3DUTC%26title%3DGeri%2520say%25C4%25B1m");
    const { deadline, parameters } = decodedCountdown(url);
    expect(Date.parse(`${deadline}Z`)).toBe(Date.UTC(2026, 8, 27, 12, 33, 59));
    expect(parameters.get("title")).toBe("Geri sayım");
  });

  it("upgrades older HTTP configuration to HTTPS for both active and paused links", () => {
    const active = new URL(buildCountdownDestinationUrl("http://onlinealarmkur.com", countdown()));
    const paused = new URL(buildCountdownDestinationUrl(
      "http://onlinealarmkur.com",
      countdown({ state: "paused", endsAtMs: null }),
    ));
    expect(active.protocol).toBe("https:");
    expect(paused.protocol).toBe("https:");
    expect(active.hostname).toBe("onlinealarmkur.com");
    expect(paused.pathname).toBe("/countdown/en/");
    expect(paused.hash).toBe("");
  });

  it("uses the campaign supplied by each product surface", () => {
    const url = new URL(buildCountdownDestinationUrl(
      "https://onlinealarmkur.com",
      countdown(),
      "subscriber-dm",
    ));
    expect(url.searchParams.get("utm_campaign")).toBe("subscriber-dm");
  });

  it("keeps paused destinations on the countdown landing page", () => {
    const url = new URL(buildCountdownDestinationUrl(
      "https://onlinealarmkur.com",
      countdown({ state: "paused", endsAtMs: null }),
    ));
    expect(url.pathname).toBe("/countdown/en/");
    expect(url.hash).toBe("");
  });

  it("normalizes a base URL without duplicating slashes", () => {
    const url = new URL(buildOnlineCountdownLandingUrl("https://onlinealarmkur.com/"));
    expect(url.pathname).toBe("/countdown/en/");
  });

  it("never creates a timer-page link", () => {
    const urls = [
      buildOnlineCountdownLandingUrl("https://onlinealarmkur.com"),
      buildOnlineCountdownUrl("https://onlinealarmkur.com", 601_000, "Launch"),
      buildCountdownDestinationUrl("https://onlinealarmkur.com", countdown()),
    ];
    expect(urls.every((url) => !url.includes("/timer/"))).toBe(true);
  });

  it("encodes title delimiters separately from the deadline parameters", () => {
    const title = "Launch &tz=Pacific/Honolulu&title=Hijacked #100% + literal%20";
    const url = new URL(buildOnlineCountdownUrl("https://example.test", 601_000, title));
    const { fragment, parameters } = decodedCountdown(url);

    expect(fragment).toContain("&tz=UTC&title=");
    expect(fragment.match(/&title=/g)).toHaveLength(1);
    expect(parameters.get("tz")).toBe("UTC");
    expect(parameters.get("title")).toBe(title);
  });

  it("truncates titles by Unicode grapheme without splitting an emoji", () => {
    const title = `${"a".repeat(79)}💥ignored`;
    const url = new URL(buildOnlineCountdownUrl("https://example.test", 601_000, title));
    const { parameters } = decodedCountdown(url);
    const linkedTitle = parameters.get("title");

    expect(linkedTitle).toBe(`${"a".repeat(79)}💥`);
    expect(Array.from(linkedTitle ?? "")).toHaveLength(80);
  });

  it("does not split a joined emoji at the title boundary", () => {
    const title = `${"a".repeat(79)}👩‍💻ignored`;
    const url = new URL(buildOnlineCountdownUrl("https://example.test", 601_000, title));
    const { parameters } = decodedCountdown(url);
    expect(parameters.get("title")).toBe(`${"a".repeat(79)}👩‍💻`);
  });

  it("caps emoji-heavy Discord links while preserving attribution and the deadline", () => {
    const result = buildOnlineCountdownUrl(
      "https://example.test",
      Date.UTC(2026, 11, 31, 23),
      "🚀".repeat(500),
      "subscriber-dm",
    );
    const url = new URL(result);
    const { fragment, parameters } = decodedCountdown(url);
    const linkedTitle = parameters.get("title") ?? "";

    expect(result.length).toBeLessThanOrEqual(512);
    expect(url.searchParams.get("utm_source")).toBe("discord");
    expect(url.searchParams.get("utm_medium")).toBe("bot");
    expect(url.searchParams.get("utm_campaign")).toBe("subscriber-dm");
    expect(fragment.startsWith("2026-12-31T23:00:00&tz=UTC&title=")).toBe(true);
    expect(linkedTitle.length).toBeGreaterThan(0);
    expect(Array.from(linkedTitle).every((character) => character === "🚀")).toBe(true);
  });

  it("replaces malformed lone surrogates instead of throwing during encoding", () => {
    const url = new URL(buildOnlineCountdownUrl("https://example.test", 601_000, `Launch\ud800night`));
    const { parameters } = decodedCountdown(url);
    expect(parameters.get("title")).toBe("Launch\ufffdnight");
  });

  it("never returns an overlong landing or countdown URL", () => {
    const campaign = "x".repeat(600);
    expect(() => buildOnlineCountdownLandingUrl("https://example.test", campaign)).toThrow(RangeError);
    expect(() => buildOnlineCountdownUrl("https://example.test", 601_000, "Launch", campaign)).toThrow(RangeError);
  });
});
