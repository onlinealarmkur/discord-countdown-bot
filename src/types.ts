export type CountdownState = "running" | "paused" | "completed" | "cancelled";
export type CountdownKind = "relative" | "event";
export type ReminderMode = "off" | "smart";
export type Sound = "silent" | "beep" | "bell" | "urgent";

export interface StoredCountdown {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string | null;
  creatorId: string;
  title: string;
  kind: CountdownKind;
  state: CountdownState;
  durationMs: number;
  remainingMs: number;
  startedAtMs: number;
  endsAtMs: number | null;
  reminderMode: ReminderMode;
  sound: Sound;
  voiceChannelId: string | null;
  mention: string;
  createdAtMs: number;
  updatedAtMs: number;
  version: number;
}

export interface DueReminder {
  countdown: StoredCountdown;
  offsetMs: number;
  attemptCount: number;
}
