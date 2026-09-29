import { describe, expect, it } from "vitest";
import { MAX_COUNTDOWN_MS } from "../src/domain/countdown.js";
import { CountdownControlError, applyCountdownControl } from "../src/domain/control.js";
import { countdown } from "./fixtures.js";

describe("applyCountdownControl", () => {
  it("pauses and resumes from the exact remaining duration", () => {
    const paused = applyCountdownControl(countdown(), "pause", 101_000);
    expect(paused).toMatchObject({ state: "paused", remainingMs: 500_000, endsAtMs: null });
    const resumed = applyCountdownControl(paused, "resume", 201_000);
    expect(resumed).toMatchObject({ state: "running", startedAtMs: 201_000, endsAtMs: 701_000 });
  });

  it("adds one minute to running and paused countdowns", () => {
    expect(applyCountdownControl(countdown(), "add", 2_000)).toMatchObject({
      durationMs: 660_000,
      remainingMs: 660_000,
      endsAtMs: 661_000,
    });
    expect(applyCountdownControl(countdown({ state: "paused", endsAtMs: null }), "add", 2_000)).toMatchObject({
      durationMs: 660_000,
      remainingMs: 660_000,
      endsAtMs: null,
    });
  });

  it("preserves the actual remaining time when cancelled", () => {
    expect(applyCountdownControl(countdown(), "cancel", 301_000)).toMatchObject({
      state: "cancelled",
      remainingMs: 300_000,
      endsAtMs: null,
    });
  });

  it("rejects invalid state transitions", () => {
    expect(() => applyCountdownControl(countdown({ state: "paused", endsAtMs: null }), "pause", 2_000))
      .toThrow(CountdownControlError);
  });

  it.each(["pause", "resume", "add", "cancel"] as const)(
    "rejects %s at the exact running deadline",
    (action) => {
      expect(() => applyCountdownControl(countdown(), action, 601_000)).toThrow(CountdownControlError);
    },
  );

  it("still permits controls immediately before the running deadline", () => {
    expect(applyCountdownControl(countdown(), "pause", 600_999)).toMatchObject({
      state: "paused",
      remainingMs: 1,
    });
  });

  it.each(["completed", "cancelled"] as const)("rejects every control after a countdown is %s", (state) => {
    for (const action of ["pause", "resume", "add", "cancel"] as const) {
      expect(() => applyCountdownControl(countdown({ state }), action, 2_000)).toThrow(CountdownControlError);
    }
  });

  it("enforces the maximum countdown length", () => {
    expect(() => applyCountdownControl(countdown({ durationMs: MAX_COUNTDOWN_MS }), "add", 2_000))
      .toThrow(CountdownControlError);
  });

  it("does not detach an event countdown from its scheduled time", () => {
    expect(() => applyCountdownControl(countdown({ kind: "event" }), "pause", 101_000))
      .toThrow(CountdownControlError);
    expect(() => applyCountdownControl(
      countdown({ kind: "event", state: "paused", endsAtMs: null }),
      "resume",
      101_000,
    )).toThrow(CountdownControlError);
    expect(() => applyCountdownControl(countdown({ kind: "event" }), "add", 101_000))
      .toThrow(CountdownControlError);
    expect(applyCountdownControl(countdown({ kind: "event" }), "cancel", 101_000).state).toBe("cancelled");
  });
});
