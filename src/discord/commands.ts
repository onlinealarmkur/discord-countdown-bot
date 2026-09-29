import { InteractionContextType, SlashCommandBuilder } from "discord.js";

const soundChoices = [
  { name: "Text only (no voice sound)", value: "silent" },
  { name: "Text + Beep (double beep)", value: "beep" },
  { name: "Text + Bell (rising chime)", value: "bell" },
  { name: "Text + Urgent (repeated alarm)", value: "urgent" },
] as const;

const countdown = new SlashCommandBuilder()
  .setName("countdown")
  .setDescription("Start a shared countdown. Run it with no options for quick buttons")
  .setContexts(InteractionContextType.Guild)
  .addStringOption((option) =>
    option
      .setName("when")
      .setDescription("Duration or event time: 5m, 1h30m, or YYYY-MM-DD HH:mm")
      .setMaxLength(64)
      .setAutocomplete(true),
  )
  .addStringOption((option) =>
    option.setName("label").setDescription("What the countdown is for").setMaxLength(100),
  )
  .addStringOption((option) =>
    option.setName("timezone").setDescription("Timezone for an exact date, e.g. Europe/London").setMaxLength(64),
  )
  .addStringOption((option) =>
    option.setName("sound").setDescription("Optional chime in your current voice channel").addChoices(...soundChoices),
  )
  .addStringOption((option) =>
    option.setName("remind_before").setDescription("Custom milestones, e.g. 7d, 1d, 1h").setMaxLength(100),
  )
  .addRoleOption((option) =>
    option.setName("notify_role").setDescription("Mention this role for reminders and time-up"),
  );

const countdowns = new SlashCommandBuilder()
  .setName("countdowns")
  .setDescription("List active countdowns")
  .setContexts(InteractionContextType.Guild)
  .addStringOption((option) =>
    option.setName("scope").setDescription("Whose countdowns to show").addChoices(
      { name: "Mine", value: "mine" },
      { name: "This server", value: "server" },
    ),
  );

const manage = new SlashCommandBuilder()
  .setName("countdown-manage")
  .setDescription("Recover or manage a countdown, even if its original message was deleted")
  .setContexts(InteractionContextType.Guild)
  .addStringOption((option) =>
    option
      .setName("countdown")
      .setDescription("Choose an active countdown")
      .setAutocomplete(true)
      .setRequired(true),
  )
  .addStringOption((option) =>
    option
      .setName("action")
      .setDescription("What to do")
      .addChoices(
        { name: "Pause", value: "pause" },
        { name: "Resume", value: "resume" },
        { name: "Add 1 minute", value: "add" },
        { name: "Cancel", value: "cancel" },
        { name: "Turn off my reminders", value: "unsubscribe" },
      )
      .setRequired(true),
  );

const help = new SlashCommandBuilder()
  .setName("countdown-help")
  .setDescription("Show countdown examples, options, permissions, and useful links")
  .setContexts(InteractionContextType.Guild);

export const commandBuilders = [countdown, countdowns, manage, help];
export const commandData = commandBuilders.map((command) => command.toJSON());
