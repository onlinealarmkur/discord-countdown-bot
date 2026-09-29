import { describe, expect, it } from "vitest";
import { buildCountdownCard } from "../src/discord/card.js";
import { countdown } from "./fixtures.js";

describe("buildCountdownCard", () => {
  it("uses a native Discord timestamp and an attributed countdown button", () => {
    const card = buildCountdownCard(countdown(), "https://onlinealarmkur.com");
    expect(card.embeds[0]?.data.description).toContain("<t:601:R>");
    const components = card.components[0]?.toJSON();
    const lastComponent = components?.components.at(-1);
    const url = lastComponent && "url" in lastComponent ? lastComponent.url : undefined;
    expect(url).toContain("onlinealarmkur.com/countdown/en/");
    expect(url).toContain("utm_source=discord");
    expect(url).not.toContain("/timer/");
  });

  it("gives the live button the website's encoded deadline, timezone and title", () => {
    const endsAtMs = Date.UTC(2026, 8, 27, 12, 33, 59);
    const card = buildCountdownCard(
      countdown({ title: "QA pause resume", endsAtMs }),
      "http://onlinealarmkur.com",
    );
    const button = card.components[0]?.toJSON().components.at(-1);
    const url = button && "url" in button ? new URL(button.url) : null;
    expect(url?.protocol).toBe("https:");
    expect(url?.hash).toBe("#2026-09-27T12%3A33%3A59%26tz%3DUTC%26title%3DQA%2520pause%2520resume");
  });

  it("escapes formatting supplied in a countdown label", () => {
    const card = buildCountdownCard(countdown({ title: "**surprise**" }), "https://onlinealarmkur.com");
    expect(card.embeds[0]?.data.title).toBe("⏳ \\*\\*surprise\\*\\*");
  });

  it("renders deceptive links and Discord tokens as literal title text", () => {
    const card = buildCountdownCard(
      countdown({ title: "[Claim](https://evil.example)\n<@123>" }),
      "https://onlinealarmkur.com",
    );
    const title = card.embeds[0]?.data.title ?? "";
    expect(title).not.toContain("](https://");
    expect(title).not.toContain("https://");
    expect(title).not.toContain("<@123>");
    expect(title).not.toContain("\n");
  });

  it("exposes all shared controls and changes pause to resume", () => {
    const running = buildCountdownCard(countdown(), "https://onlinealarmkur.com").components[0]?.toJSON();
    expect(running?.components.slice(0, 4).map((component) =>
      "custom_id" in component ? component.custom_id : null,
    )).toEqual([
      "countdown:pause:countdown-1",
      "countdown:add:countdown-1",
      "countdown:subscribe:countdown-1",
      "countdown:cancel:countdown-1",
    ]);

    const paused = buildCountdownCard(
      countdown({ state: "paused", endsAtMs: null }),
      "https://onlinealarmkur.com",
    ).components[0]?.toJSON();
    expect(paused?.components[0] && "custom_id" in paused.components[0]
      ? paused.components[0].custom_id
      : null).toBe("countdown:resume:countdown-1");
  });

  it.each(["completed", "cancelled"] as const)("disables mutating controls after %s", (state) => {
    const terminal = buildCountdownCard(
      countdown({ state, remainingMs: 0 }),
      "https://onlinealarmkur.com",
    ).components[0]?.toJSON();
    expect(terminal?.components.slice(0, 4).every((component) =>
      "disabled" in component && component.disabled,
    )).toBe(true);
  });

  it("shows event countdowns as fixed and prevents extending them", () => {
    const event = buildCountdownCard(countdown({ kind: "event" }), "https://onlinealarmkur.com")
      .components[0]?.toJSON().components;
    const fixedTime = event?.[0];
    const addMinute = event?.[1];
    expect(fixedTime && "label" in fixedTime ? fixedTime.label : null).toBe("Fixed time");
    expect(fixedTime && "disabled" in fixedTime ? fixedTime.disabled : null).toBe(true);
    expect(addMinute && "label" in addMinute ? addMinute.label : null).toBe("+1 minute");
    expect(addMinute && "disabled" in addMinute ? addMinute.disabled : null).toBe(true);
  });

  it("makes clear that voice sounds are added to the dependable text alert", () => {
    const card = buildCountdownCard(countdown({ sound: "beep", voiceChannelId: "voice-1" }), "https://onlinealarmkur.com");
    expect(card.embeds[0]?.data.fields?.find(({ name }) => name === "Alert")?.value)
      .toBe("Text notification + Beep in <#voice-1>");
  });

  it("falls back to the countdown landing page while paused", () => {
    const card = buildCountdownCard(countdown({ state: "paused", endsAtMs: null }), "https://onlinealarmkur.com");
    const component = card.components[0]?.toJSON().components.at(-1);
    const url = component && "url" in component ? new URL(component.url) : null;
    expect(url?.pathname).toBe("/countdown/en/");
    expect(url?.hash).toBe("");
  });
});
