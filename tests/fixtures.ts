import type { StoredCountdown } from "../src/types.js";

export function countdown(overrides: Partial<StoredCountdown> = {}): StoredCountdown {
  return {
    id: "countdown-1",
    guildId: "guild-1",
    channelId: "channel-1",
    messageId: "message-1",
    creatorId: "creator-1",
    title: "Launch night",
    kind: "relative",
    state: "running",
    durationMs: 600_000,
    remainingMs: 600_000,
    startedAtMs: 1_000,
    endsAtMs: 601_000,
    reminderMode: "smart",
    sound: "silent",
    voiceChannelId: null,
    mention: "<@123456789012345678>",
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    version: 0,
    ...overrides,
  };
}
