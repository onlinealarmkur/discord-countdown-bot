import { describe, expect, it } from "vitest";
import {
  CountdownError,
  exampleEventWhen,
  parseCountdownTarget,
  resolveCountdownTarget,
} from "../src/domain/countdown.js";

describe("parseCountdownTarget", () => {
  it("keeps an explicit UTC target exact", () => {
    expect(parseCountdownTarget("2026-06-01", "12:30", "UTC", Date.UTC(2026, 4, 31))).toBe(
      Date.UTC(2026, 5, 1, 12, 30),
    );
  });

  it("converts a zoned wall-clock time to an instant", () => {
    expect(parseCountdownTarget("2026-12-31", "23:00", "Europe/Madrid", Date.UTC(2026, 11, 30))).toBe(
      Date.UTC(2026, 11, 31, 22, 0),
    );
  });

  it("trims incidental whitespace around a timezone", () => {
    expect(parseCountdownTarget("2026-12-31", "23:00", "  Europe/Madrid\t", Date.UTC(2026, 11, 30))).toBe(
      Date.UTC(2026, 11, 31, 22, 0),
    );
  });

  it.each([
    ["31-12-2026", "23:00", "Europe/Madrid"],
    ["2026-12-31", "25:00", "Europe/Madrid"],
    ["2026-12-31", "23:00", "Mars/Olympus"],
  ])("rejects invalid input", (date, time, zone) => {
    expect(() => parseCountdownTarget(date, time, zone, Date.UTC(2026, 0, 1))).toThrow(CountdownError);
  });

  it("rejects a local time skipped by daylight-saving time", () => {
    expect(() => parseCountdownTarget("2027-03-28", "02:30", "Europe/Madrid", Date.UTC(2027, 2, 1)))
      .toThrow(CountdownError);
  });

  it("rejects a local time repeated by daylight-saving time", () => {
    expect(() => parseCountdownTarget("2026-10-25", "02:30", "Europe/Madrid", Date.UTC(2026, 9, 1)))
      .toThrow(CountdownError);
  });

  it.each([
    ["2026-04-05", "01:45", "Australia/Lord_Howe"],
    ["2026-11-01", "01:15", "America/St_Johns"],
    ["2026-04-05", "03:15", "Pacific/Chatham"],
  ])("rejects non-hour repeated local time %s %s in %s", (date, time, zone) => {
    expect(() => parseCountdownTarget(date, time, zone, Date.UTC(2026, 0, 1))).toThrow(
      "That local time occurs twice because of daylight saving.",
    );
  });

  it.each([
    ["2026-10-04", "02:15", "Australia/Lord_Howe"],
    ["2026-09-27", "02:45", "Pacific/Chatham"],
    ["2011-12-30", "12:00", "Pacific/Apia"],
  ])("rejects skipped local time %s %s in %s", (date, time, zone) => {
    expect(() => parseCountdownTarget(date, time, zone, Date.UTC(2011, 0, 1))).toThrow(
      "That local time does not exist in the selected timezone.",
    );
  });

  it("rejects past and excessively distant countdowns", () => {
    const nowMs = Date.UTC(2026, 0, 1);
    expect(() => parseCountdownTarget("2025-12-31", "23:59", "UTC", nowMs)).toThrow(CountdownError);
    expect(() => parseCountdownTarget("2032-01-01", "00:00", "UTC", nowMs)).toThrow(CountdownError);
  });

  it("uses the exact fifth calendar anniversary as the event limit", () => {
    const nowMs = Date.UTC(2026, 0, 1);
    expect(parseCountdownTarget("2031-01-01", "00:00", "UTC", nowMs)).toBe(Date.UTC(2031, 0, 1));
    expect(() => parseCountdownTarget("2031-01-02", "00:00", "UTC", nowMs)).toThrow(
      "Countdowns can be at most five years away.",
    );
  });

  it("handles a leap-day fifth calendar anniversary without a fixed-day approximation", () => {
    const nowMs = Date.UTC(2028, 1, 29, 12);
    expect(parseCountdownTarget("2033-02-28", "12:00", "UTC", nowMs)).toBe(Date.UTC(2033, 1, 28, 12));
    expect(() => parseCountdownTarget("2033-03-01", "12:00", "UTC", nowMs)).toThrow(
      "Countdowns can be at most five years away.",
    );
  });

  it("distinguishes past targets from targets under the five-second minimum", () => {
    const targetMs = Date.UTC(2026, 0, 1, 12);
    expect(() => parseCountdownTarget("2026-01-01", "12:00", "UTC", targetMs)).toThrow(
      "The countdown must end in the future.",
    );
    expect(() => parseCountdownTarget("2026-01-01", "12:00", "UTC", targetMs - 4_999)).toThrow(
      "The countdown must end at least 5 seconds in the future.",
    );
    expect(parseCountdownTarget("2026-01-01", "12:00", "UTC", targetMs - 5_000)).toBe(targetMs);
  });
});

describe("resolveCountdownTarget", () => {
  const nowMs = Date.UTC(2026, 0, 1);

  it("supports a relative countdown through the countdown command", () => {
    expect(resolveCountdownTarget({ when: "5m", timezone: "UTC" }, nowMs)).toEqual({
      endsAtMs: nowMs + 300_000,
      kind: "relative",
    });
  });

  it("supports an exact event through the same command", () => {
    expect(resolveCountdownTarget({ when: "2026-01-02 12:00", timezone: "UTC" }, nowMs)).toEqual({
      endsAtMs: Date.UTC(2026, 0, 2, 12),
      kind: "event",
    });
  });

  it("requires one input mode", () => {
    expect(() => resolveCountdownTarget({ timezone: "UTC" }, nowMs)).toThrow(CountdownError);
  });

  it("accepts an ISO-style separator for events", () => {
    expect(resolveCountdownTarget({ when: "2026-01-02T12:00", timezone: "UTC" }, nowMs).kind).toBe("event");
  });

  it.each(["2026-01-02t12:00", "2026-01-02  \t 12:00"])(
    "accepts one event separator run in %s",
    (when) => expect(resolveCountdownTarget({ when, timezone: "UTC" }, nowMs).kind).toBe("event"),
  );

  it.each([
    "2026-01-02TT12:00",
    "2026-01-02Tt12:00",
    "2026-01-02 T 12:00",
    "2026-01-02T 12:00",
    "2026-01-0212:00",
    "2026-01-02 24:00",
  ])("rejects malformed or mixed event separators in %s", (when) => {
    expect(() => resolveCountdownTarget({ when, timezone: "UTC" }, nowMs)).toThrow(CountdownError);
  });
});

describe("exampleEventWhen", () => {
  it.each([
    [Date.UTC(2026, 8, 24), "2027-01-01 00:00"],
    [Date.UTC(2026, 11, 29, 23, 59), "2027-01-01 00:00"],
    [Date.UTC(2026, 11, 30), "2028-01-01 00:00"],
    [Date.UTC(2026, 11, 31, 10), "2028-01-01 00:00"],
    [Date.UTC(2027, 0, 1), "2028-01-01 00:00"],
  ])("never suggests a past or imminent New Year's midnight at %i", (nowMs, expected) => {
    expect(exampleEventWhen(nowMs)).toBe(expected);
    expect(resolveCountdownTarget({ when: expected, timezone: "Pacific/Kiritimati" }, nowMs).kind).toBe("event");
  });

  it("keeps the example in validation errors current", () => {
    const nowMs = Date.UTC(2031, 11, 30);
    expect(() => resolveCountdownTarget({ when: "", timezone: "UTC" }, nowMs)).toThrow("2033-01-01 00:00");
  });
});
