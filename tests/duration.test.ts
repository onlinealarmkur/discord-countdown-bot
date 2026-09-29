import { describe, expect, it } from "vitest";
import {
  DurationError,
  formatDuration,
  parseRelativeCountdown,
  parseReminderOffsets,
  smartReminderOffsets,
} from "../src/domain/duration.js";

describe("parseRelativeCountdown", () => {
  it.each([
    ["45s", 45_000],
    ["5m", 300_000],
    ["1h30m", 5_400_000],
    ["1h 30m", 5_400_000],
    ["1 hour 30 minutes", 5_400_000],
    ["90min", 5_400_000],
    ["1d2h15m", 94_500_000],
    [" 2H 5M ", 7_500_000],
    ["365d", 31_536_000_000],
  ])("parses %s", (input, expected) => expect(parseRelativeCountdown(input)).toBe(expected));

  it.each([
    "",
    "5",
    "one hour",
    "3m later",
    "4s",
    "366d",
    "-5m",
    "+5m",
    "1.5h",
    "1e3s",
    "５m",
    "5ｍ",
    "5m\u200b",
    "9007199254740991s",
  ])('rejects "%s"', (input) => {
    expect(() => parseRelativeCountdown(input)).toThrow(DurationError);
  });
});

describe("formatDuration", () => {
  it("uses two useful units", () => expect(formatDuration(5_430_000)).toBe("1 hour 30 minutes"));
  it("rounds partial seconds up", () => expect(formatDuration(1_001)).toBe("2 seconds"));
  it("never displays a negative amount", () => expect(formatDuration(-1)).toBe("0 seconds"));
});

describe("smartReminderOffsets", () => {
  it("keeps useful milestones without duplicates", () => {
    expect(smartReminderOffsets(7_200_000)).toEqual([3_600_000, 600_000, 60_000]);
  });
  it("does not spam a one-minute countdown", () => expect(smartReminderOffsets(60_000)).toEqual([]));
});

describe("parseReminderOffsets", () => {
  it("parses and sorts custom milestones", () => {
    expect(parseReminderOffsets("10m, 1d, 1h", 2 * 86_400_000)).toEqual([86_400_000, 3_600_000, 600_000]);
  });

  it.each(["", "1h, 1h", "30s", "2d", "1m,2m,3m,4m,5m,6m,7m"])(
    'rejects unusable milestones: "%s"',
    (input) => expect(() => parseReminderOffsets(input, 2 * 86_400_000)).toThrow(DurationError),
  );

  it("keeps a minute between creation and the first milestone", () => {
    expect(() => parseReminderOffsets("1d", 86_430_000)).toThrow(DurationError);
  });

  it("allows reminder offsets beyond the relative-countdown limit for long events", () => {
    const twoYearsMs = 730 * 86_400_000;
    expect(parseReminderOffsets("400d, 366d", twoYearsMs)).toEqual([
      400 * 86_400_000,
      366 * 86_400_000,
    ]);
  });

  it("still constrains long reminders to the actual event duration", () => {
    const twoYearsMs = 730 * 86_400_000;
    expect(() => parseReminderOffsets("730d", twoYearsMs)).toThrow(
      "Each custom reminder must occur at least 1 minute after creation and before the end.",
    );
  });

  it("rejects semantically duplicate reminder spellings", () => {
    expect(() => parseReminderOffsets("1h, 60m", 3_600_000 * 2)).toThrow(
      "Custom reminder times must be unique.",
    );
  });
});
