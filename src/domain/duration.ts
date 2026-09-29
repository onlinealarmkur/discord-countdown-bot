const UNIT_MS = {
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
  s: 1_000,
} as const;

export const MIN_DURATION_MS = 5_000;
export const MAX_RELATIVE_COUNTDOWN_MS = 365 * UNIT_MS.d;
export const MAX_CUSTOM_REMINDERS = 6;

export class DurationError extends Error {}

function unitKey(unit: string): keyof typeof UNIT_MS {
  if (unit.startsWith("d")) return "d";
  if (unit.startsWith("h")) return "h";
  if (unit.startsWith("m")) return "m";
  return "s";
}

function parseDurationValue(input: string): number {
  const normalized = input.trim().toLowerCase();
  if (!normalized) throw new DurationError("Enter a duration such as `5m`, `1h30m`, or `45s`.");

  const tokenPattern = /(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)/g;
  let total = 0;
  let match: RegExpExecArray | null;
  let consumed = "";

  while ((match = tokenPattern.exec(normalized)) !== null) {
    const amount = Number(match[1]);
    const unit = unitKey(match[2] as string);
    if (!Number.isSafeInteger(amount)) throw new DurationError("The duration is too large.");
    total += amount * UNIT_MS[unit];
    if (!Number.isSafeInteger(total)) throw new DurationError("The duration is too large.");
    consumed += match[0];
  }

  if (!consumed || consumed.replace(/\s+/g, "") !== normalized.replace(/\s+/g, "")) {
    throw new DurationError("Use a compact duration such as `1h30m`, `90m`, or `2 hours 15 minutes`.");
  }
  return total;
}

export function parseRelativeCountdown(input: string): number {
  const total = parseDurationValue(input);
  if (total < MIN_DURATION_MS) throw new DurationError("Countdowns must be at least 5 seconds long.");
  if (total > MAX_RELATIVE_COUNTDOWN_MS) {
    throw new DurationError("Relative countdowns can run for at most 365 days.");
  }
  return total;
}

export function formatDuration(milliseconds: number): string {
  let seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const parts: string[] = [];
  const units: Array<[string, number]> = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
    ["second", 1],
  ];

  for (const [label, unitSeconds] of units) {
    const amount = Math.floor(seconds / unitSeconds);
    if (amount > 0) {
      parts.push(`${amount} ${label}${amount === 1 ? "" : "s"}`);
      seconds %= unitSeconds;
    }
    if (parts.length === 2) break;
  }
  return parts.join(" ") || "0 seconds";
}

export function smartReminderOffsets(durationMs: number): number[] {
  const candidates = [
    30 * UNIT_MS.d,
    7 * UNIT_MS.d,
    UNIT_MS.d,
    UNIT_MS.h,
    10 * UNIT_MS.m,
    UNIT_MS.m,
  ];
  return candidates.filter((offset) => offset < durationMs && durationMs - offset >= UNIT_MS.m);
}

export function parseReminderOffsets(input: string, durationMs: number): number[] {
  const values = input.split(",").map((value) => value.trim());
  if (values.some((value) => !value)) {
    throw new DurationError("Separate custom reminders with commas, for example `7d, 1d, 1h`.");
  }
  if (values.length > MAX_CUSTOM_REMINDERS) {
    throw new DurationError(`Use no more than ${MAX_CUSTOM_REMINDERS} custom reminders.`);
  }

  const offsets = values.map(parseDurationValue);
  if (offsets.some((offset) => offset < UNIT_MS.m)) {
    throw new DurationError("Custom reminders must be at least 1 minute before the end.");
  }
  if (offsets.some((offset) => offset >= durationMs || durationMs - offset < UNIT_MS.m)) {
    throw new DurationError("Each custom reminder must occur at least 1 minute after creation and before the end.");
  }

  const unique = [...new Set(offsets)];
  if (unique.length !== offsets.length) throw new DurationError("Custom reminder times must be unique.");
  return unique.sort((left, right) => right - left);
}
