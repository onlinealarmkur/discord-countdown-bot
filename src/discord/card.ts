import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { formatDuration } from "../domain/duration.js";
import { buildCountdownDestinationUrl } from "../domain/links.js";
import type { Sound, StoredCountdown } from "../types.js";
import { literalDiscordText } from "./literal-text.js";

const STATE = {
  running: { emoji: "⏳", label: "Running", color: 0x5865f2 },
  paused: { emoji: "⏸️", label: "Paused", color: 0xfee75c },
  completed: { emoji: "⏰", label: "Time's up", color: 0x57f287 },
  cancelled: { emoji: "⏹️", label: "Cancelled", color: 0x99aab5 },
} as const;

const SOUND_LABEL: Record<Sound, string> = {
  silent: "Text notification",
  beep: "Text notification + Beep",
  bell: "Text notification + Bell",
  urgent: "Text notification + Urgent alarm",
};

export interface CountdownCard {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
}

function countdownDescription(countdown: StoredCountdown): string {
  if (countdown.state === "running" && countdown.endsAtMs !== null) {
    const unix = Math.floor(countdown.endsAtMs / 1_000);
    return `Ends <t:${unix}:R> • <t:${unix}:F>`;
  }
  if (countdown.state === "paused") return `${formatDuration(countdown.remainingMs)} remaining`;
  if (countdown.state === "completed") return `Finished <t:${Math.floor(countdown.updatedAtMs / 1_000)}:R>`;
  return `Stopped <t:${Math.floor(countdown.updatedAtMs / 1_000)}:R>`;
}

export function buildCountdownCard(countdown: StoredCountdown, siteBaseUrl: string): CountdownCard {
  const state = STATE[countdown.state];
  const terminal = countdown.state === "completed" || countdown.state === "cancelled";
  const alert = countdown.voiceChannelId && countdown.sound !== "silent"
    ? `${SOUND_LABEL[countdown.sound]} in <#${countdown.voiceChannelId}>`
    : "Text notification";

  const embed = new EmbedBuilder()
    .setColor(state.color)
    .setTitle(`${state.emoji} ${literalDiscordText(countdown.title)}`)
    .setDescription(countdownDescription(countdown))
    .addFields(
      { name: "Status", value: state.label, inline: true },
      { name: "Alert", value: alert, inline: true },
      { name: "Reminders", value: countdown.reminderMode === "smart" ? "Milestones enabled" : "At the end", inline: true },
    )
    .setFooter({ text: `Countdown Bot • ${countdown.id.slice(0, 8)}` })
    .setTimestamp(countdown.createdAtMs);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`countdown:${countdown.state === "paused" ? "resume" : "pause"}:${countdown.id}`)
      .setLabel(countdown.kind === "event" ? "Fixed time" : countdown.state === "paused" ? "Resume" : "Pause")
      .setEmoji(countdown.kind === "event" ? "📌" : countdown.state === "paused" ? "▶️" : "⏸️")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(terminal || countdown.kind === "event"),
    new ButtonBuilder()
      .setCustomId(`countdown:add:${countdown.id}`)
      .setLabel("+1 minute")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(terminal || countdown.kind === "event"),
    new ButtonBuilder()
      .setCustomId(`countdown:subscribe:${countdown.id}`)
      .setLabel("Remind me")
      .setEmoji("🔔")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(terminal),
    new ButtonBuilder()
      .setCustomId(`countdown:cancel:${countdown.id}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(terminal),
    new ButtonBuilder()
      .setLabel("Open live countdown")
      .setStyle(ButtonStyle.Link)
      .setURL(buildCountdownDestinationUrl(siteBaseUrl, countdown)),
  );

  return { embeds: [embed], components: [row] };
}
