import type { StoredCountdown } from "../types.js";
import { MAX_COUNTDOWN_MS } from "./countdown.js";

export type CountdownControlAction = "pause" | "resume" | "add" | "cancel";

export class CountdownControlError extends Error {}

export function isCountdownControlAction(value: string): value is CountdownControlAction {
  return value === "pause" || value === "resume" || value === "add" || value === "cancel";
}

export function applyCountdownControl(
  countdown: StoredCountdown,
  action: CountdownControlAction,
  nowMs = Date.now(),
): StoredCountdown {
  if (countdown.state === "completed" || countdown.state === "cancelled") {
    throw new CountdownControlError("That countdown has already ended.");
  }
  if (
    countdown.state === "running" &&
    countdown.endsAtMs !== null &&
    countdown.endsAtMs <= nowMs
  ) {
    throw new CountdownControlError("That countdown has already ended.");
  }

  switch (action) {
    case "pause": {
      if (countdown.kind === "event") {
        throw new CountdownControlError("Event countdowns stay tied to their scheduled time and cannot be paused.");
      }
      if (countdown.state !== "running" || countdown.endsAtMs === null) {
        throw new CountdownControlError("That countdown is not running.");
      }
      const remainingMs = Math.max(0, countdown.endsAtMs - nowMs);
      if (remainingMs === 0) throw new CountdownControlError("That countdown has already ended.");
      return { ...countdown, state: "paused", remainingMs, endsAtMs: null, updatedAtMs: nowMs };
    }
    case "resume":
      if (countdown.kind === "event") {
        throw new CountdownControlError("Event countdowns stay tied to their scheduled time and cannot be resumed.");
      }
      if (countdown.state !== "paused" || countdown.remainingMs <= 0) {
        throw new CountdownControlError("That countdown is not paused.");
      }
      return {
        ...countdown,
        state: "running",
        startedAtMs: nowMs,
        endsAtMs: nowMs + countdown.remainingMs,
        updatedAtMs: nowMs,
      };
    case "add":
      if (countdown.kind === "event") {
        throw new CountdownControlError("Event countdowns stay tied to their scheduled time and cannot be extended.");
      }
      if (countdown.durationMs > MAX_COUNTDOWN_MS - 60_000) {
        throw new CountdownControlError("That countdown is already at its maximum length.");
      }
      return countdown.state === "running" && countdown.endsAtMs !== null
        ? {
            ...countdown,
            durationMs: countdown.durationMs + 60_000,
            remainingMs: countdown.remainingMs + 60_000,
            endsAtMs: countdown.endsAtMs + 60_000,
            updatedAtMs: nowMs,
          }
        : {
            ...countdown,
            durationMs: countdown.durationMs + 60_000,
            remainingMs: countdown.remainingMs + 60_000,
            updatedAtMs: nowMs,
          };
    case "cancel": {
      const remainingMs = countdown.state === "running" && countdown.endsAtMs !== null
        ? Math.max(0, countdown.endsAtMs - nowMs)
        : countdown.remainingMs;
      return { ...countdown, state: "cancelled", remainingMs, endsAtMs: null, updatedAtMs: nowMs };
    }
  }
}
