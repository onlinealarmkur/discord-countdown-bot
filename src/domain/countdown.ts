import { DateTime, IANAZone } from "luxon";
import { MIN_DURATION_MS, parseRelativeCountdown } from "./duration.js";

export class CountdownError extends Error {}

// Control actions use this conservative fixed-duration ceiling. Exact event
// creation below is limited to the real fifth calendar anniversary instead.
export const MAX_COUNTDOWN_MS = 5 * 366 * 86_400_000;

/** New Year's midnight as a `when` example, with year-end headroom in every timezone. */
export function exampleEventWhen(nowMs = Date.now()): string {
  const now = new Date(nowMs);
  const lateDecember = now.getUTCMonth() === 11 && now.getUTCDate() >= 30;
  return `${now.getUTCFullYear() + 1 + (lateDecember ? 1 : 0)}-01-01 00:00`;
}

export interface ResolvedCountdownTarget {
  endsAtMs: number;
  kind: "relative" | "event";
}

export function parseCountdownTarget(
  date: string,
  time: string,
  timezone: string,
  nowMs = Date.now(),
): number {
  const normalizedTimezone = timezone.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new CountdownError(`Use \`YYYY-MM-DD\` for the date, for example \`${exampleEventWhen(nowMs).slice(0, 10)}\`.`);
  }
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new CountdownError("Use 24-hour `HH:mm` time, for example `18:30`.");
  }
  if (!IANAZone.isValidZone(normalizedTimezone)) {
    throw new CountdownError("Use an IANA timezone such as `Europe/Madrid` or `America/New_York`.");
  }

  const target = DateTime.fromISO(`${date}T${time}`, { zone: normalizedTimezone, setZone: true });
  if (!target.isValid) throw new CountdownError("That date and time is not valid in the selected timezone.");
  if (target.toFormat("yyyy-MM-dd'T'HH:mm") !== `${date}T${time}`) {
    throw new CountdownError("That local time does not exist in the selected timezone.");
  }
  if (target.getPossibleOffsets().length > 1) {
    throw new CountdownError("That local time occurs twice because of daylight saving. Use `UTC` to choose an exact time.");
  }

  const durationMs = target.toMillis() - nowMs;
  if (durationMs <= 0) throw new CountdownError("The countdown must end in the future.");
  if (durationMs < MIN_DURATION_MS) {
    throw new CountdownError("The countdown must end at least 5 seconds in the future.");
  }
  const maximumTargetMs = DateTime.fromMillis(nowMs, { zone: normalizedTimezone }).plus({ years: 5 }).toMillis();
  if (target.toMillis() > maximumTargetMs) {
    throw new CountdownError("Countdowns can be at most five years away.");
  }
  return target.toMillis();
}

export interface CountdownInput {
  when?: string | undefined;
  timezone: string;
}

export function resolveCountdownTarget(input: CountdownInput, nowMs = Date.now()): ResolvedCountdownTarget {
  const when = input.when?.trim();
  if (!when) {
    throw new CountdownError(`Enter a duration such as \`5m\`, or an event such as \`${exampleEventWhen(nowMs)}\`.`);
  }

  const event = /^(\d{4}-\d{2}-\d{2})(?:[Tt]|\s+)((?:[01]\d|2[0-3]):[0-5]\d)$/.exec(when);
  if (event) {
    return {
      endsAtMs: parseCountdownTarget(event[1] as string, event[2] as string, input.timezone, nowMs),
      kind: "event",
    };
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(when)) {
    const example = exampleEventWhen(nowMs);
    throw new CountdownError(`Use an event time such as \`${example}\` or \`${example.replace(" ", "T")}\`.`);
  }

  return { endsAtMs: nowMs + parseRelativeCountdown(when), kind: "relative" };
}
