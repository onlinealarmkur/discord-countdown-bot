import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  GuildMember,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type ModalSubmitInteraction,
  type PermissionsBitField,
  type Role,
  type StringSelectMenuInteraction,
  type VoiceBasedChannel,
} from "discord.js";
import type { AppConfig } from "../config.js";
import { CountdownDatabase } from "../database.js";
import {
  CountdownError,
  exampleEventWhen,
  resolveCountdownTarget,
  type ResolvedCountdownTarget,
} from "../domain/countdown.js";
import {
  CountdownControlError,
  applyCountdownControl,
  isCountdownControlAction,
} from "../domain/control.js";
import {
  DurationError,
  formatDuration,
  parseReminderOffsets,
  smartReminderOffsets,
} from "../domain/duration.js";
import { DEFAULT_COUNTDOWN_LIMITS, type CountdownLimits } from "../domain/limits.js";
import { buildOnlineCountdownLandingUrl } from "../domain/links.js";
import { unicodeGraphemes } from "../domain/unicode.js";
import type { ReminderMode, Sound, StoredCountdown } from "../types.js";
import { buildCountdownCard } from "./card.js";
import { literalDiscordText, singleLineDiscordText } from "./literal-text.js";

const MAX_SUBSCRIBERS_PER_COUNTDOWN = 500;
const MAX_AUDIBLE_COUNTDOWNS_PER_USER = 3;
const MAX_AUDIBLE_COUNTDOWNS_PER_GUILD = 10;

const quickDurations = [
  { name: "5 minutes", value: "5m" },
  { name: "10 minutes", value: "10m" },
  { name: "30 minutes", value: "30m" },
  { name: "1 hour", value: "1h" },
  { name: "1 hour 30 minutes", value: "1h30m" },
  { name: "2 hours", value: "2h" },
  { name: "1 day", value: "1d" },
  { name: "7 days", value: "7d" },
] as const;

const soundDetails: Record<Sound, { label: string; description: string; emoji: string }> = {
  silent: { label: "Text only (no beep)", description: "Channel alert; subscriber DMs; no voice sound", emoji: "🔕" },
  beep: { label: "Text + Beep", description: "Channel alert plus a short double beep", emoji: "🔊" },
  bell: { label: "Text + Bell", description: "Channel alert plus a rising three-note voice chime", emoji: "🛎️" },
  urgent: { label: "Text + Urgent", description: "Channel alert plus a repeated voice alarm", emoji: "🚨" },
};

function isSound(value: string): value is Sound {
  return value === "silent" || value === "beep" || value === "bell" || value === "urgent";
}

export interface ResolvedVoiceAlert {
  sound: Sound;
  voiceChannelId: string | null;
  fallbackReason: string | null;
}

export function resolveVoiceAlert(
  requestedSound: Sound,
  voiceChannel: VoiceBasedChannel | null,
  botMember: GuildMember | null,
): ResolvedVoiceAlert {
  if (requestedSound === "silent") {
    return { sound: "silent", voiceChannelId: null, fallbackReason: null };
  }
  if (!voiceChannel) {
    return {
      sound: "silent",
      voiceChannelId: null,
      fallbackReason: "you were not in a voice channel at creation time.",
    };
  }
  if (voiceChannel.type !== ChannelType.GuildVoice) {
    return {
      sound: "silent",
      voiceChannelId: null,
      fallbackReason: "Stage channels cannot provide a dependable audible alert.",
    };
  }
  if (!botMember) {
    return {
      sound: "silent",
      voiceChannelId: null,
      fallbackReason: "the bot could not verify its voice permissions.",
    };
  }
  let permissions: Readonly<PermissionsBitField> | null;
  try {
    permissions = voiceChannel.permissionsFor(botMember);
  } catch {
    permissions = null;
  }
  if (!permissions) {
    return {
      sound: "silent",
      voiceChannelId: null,
      fallbackReason: "the bot could not verify its voice permissions.",
    };
  }
  if (!permissions.has([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.Connect,
    PermissionFlagsBits.Speak,
  ])) {
    return {
      sound: "silent",
      voiceChannelId: null,
      fallbackReason: "the bot needs View Channel, Connect, and Speak permissions there.",
    };
  }
  if (voiceChannel.full && !permissions.has(PermissionFlagsBits.MoveMembers)) {
    return { sound: "silent", voiceChannelId: null, fallbackReason: "that voice channel is full." };
  }
  return { sound: requestedSound, voiceChannelId: voiceChannel.id, fallbackReason: null };
}

class InteractionError extends Error {}

interface CountdownChannelContext {
  appPermissions: Readonly<PermissionsBitField> | null;
  memberPermissions: Readonly<PermissionsBitField> | null;
  channel: { isThread(): boolean } | null;
}

/**
 * Refuses a countdown the bot could not deliver, or that the member could not have posted themselves.
 * Accepting one would leave its alerts failing with 403s, which count toward Discord's invalid-request IP ban.
 */
function assertCanPostCountdown(interaction: CountdownChannelContext): void {
  const inThread = interaction.channel?.isThread() === true;
  const send = inThread ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
  if (interaction.memberPermissions && !interaction.memberPermissions.has(send)) {
    throw new InteractionError("You can't send messages in this channel, so you can't start a countdown here.");
  }
  const app = interaction.appPermissions;
  if (!app) return;
  const required: [bigint, string][] = [
    [PermissionFlagsBits.ViewChannel, "View Channel"],
    [send, inThread ? "Send Messages in Threads" : "Send Messages"],
    [PermissionFlagsBits.EmbedLinks, "Embed Links"],
    [PermissionFlagsBits.ReadMessageHistory, "Read Message History"],
  ];
  const missing = required.filter(([flag]) => !app.has(flag)).map(([, name]) => name);
  if (missing.length) {
    throw new InteractionError(
      `I can't post countdown alerts here. I'm missing ${missing.join(", ")} in this channel. ` +
      "Ask a server admin to allow them, or use another channel.",
    );
  }
}

function isDefinitiveDiscordRejection(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = Number((error as { code?: unknown }).code);
  return code === 10_008 || code === 10_062 || code === 50_001 || code === 50_013 || code === 50_035;
}

export function truncateDiscordText(value: string, maxLength: number): string {
  if (!Number.isSafeInteger(maxLength) || maxLength < 0) {
    throw new RangeError("Discord text limits must be non-negative safe integers.");
  }
  let result = "";
  for (const grapheme of unicodeGraphemes(value)) {
    if (result.length + grapheme.length > maxLength) break;
    result += grapheme;
  }
  return result;
}

interface ChannelPermissionResolver {
  permissionsFor(userId: string): { has(permissions: bigint | readonly bigint[]): boolean } | null;
  type?: number;
  members?: {
    fetch?(options: { member: string; force: true; cache: false }): Promise<unknown>;
  };
}

export function hasCountdownChannelPermission(
  channel: unknown,
  userId: string,
  permission: bigint = PermissionFlagsBits.ViewChannel,
): boolean {
  if (!channel || typeof channel !== "object" || !("permissionsFor" in channel) ||
    typeof (channel as Partial<ChannelPermissionResolver>).permissionsFor !== "function") return false;
  try {
    const candidate = channel as ChannelPermissionResolver;
    const permissions = candidate.permissionsFor(userId);
    const required = permission === PermissionFlagsBits.ViewChannel
      ? PermissionFlagsBits.ViewChannel
      : [PermissionFlagsBits.ViewChannel, permission] as const;
    if (permissions?.has(required) !== true) return false;
    if (candidate.type !== ChannelType.PrivateThread) return true;
    if (permissions.has(PermissionFlagsBits.Administrator) ||
      permissions.has(PermissionFlagsBits.ManageThreads)) return true;
    // GuildMembers is deliberately disabled, so removals do not invalidate this
    // cache. Only the async helper's fresh REST result can authorize a member.
    return false;
  } catch {
    return false;
  }
}

async function hasCountdownChannelPermissionAsync(
  channel: unknown,
  userId: string,
  permission: bigint = PermissionFlagsBits.ViewChannel,
): Promise<boolean> {
  if (hasCountdownChannelPermission(channel, userId, permission)) return true;
  if (!channel || typeof channel !== "object" || !("permissionsFor" in channel) ||
    typeof (channel as Partial<ChannelPermissionResolver>).permissionsFor !== "function") return false;
  const candidate = channel as ChannelPermissionResolver;
  if (candidate.type !== ChannelType.PrivateThread || typeof candidate.members?.fetch !== "function") return false;
  try {
    const permissions = candidate.permissionsFor(userId);
    const required = permission === PermissionFlagsBits.ViewChannel
      ? PermissionFlagsBits.ViewChannel
      : [PermissionFlagsBits.ViewChannel, permission] as const;
    if (permissions?.has(required) !== true) return false;
    return Boolean(await candidate.members.fetch({ member: userId, force: true, cache: false }));
  } catch {
    return false;
  }
}

async function fetchCountdownChannel(client: Client, channelId: string): Promise<unknown> {
  const cached = client.channels.cache.get(channelId);
  if (cached) return cached;
  try {
    return await client.channels.fetch(channelId);
  } catch {
    return null;
  }
}

type HandlerConfig = Pick<AppConfig, "siteBaseUrl" | "defaultTimezone">
  & Partial<Pick<AppConfig, "supportServerUrl" | "privacyPolicyUrl" | "countdownLimits">>;

export interface InteractionHandlerController {
  stop(): void;
  drain(): Promise<void>;
}

export function installInteractionHandlers(
  client: Client,
  database: CountdownDatabase,
  config: HandlerConfig,
): InteractionHandlerController {
  const active = new Set<Promise<void>>();
  let accepting = true;
  const listener = (interaction: Interaction) => {
    if (!accepting) return;
    const job = (async (): Promise<void> => {
      try {
      if (interaction.isAutocomplete()) {
        await handleAutocomplete(interaction, database, config);
        return;
      }
      if (interaction.isChatInputCommand()) {
        await handleCommand(interaction, database, config);
        return;
      }
      if (interaction.isButton() && interaction.customId.startsWith("countdown:")) {
        await handleButton(interaction, database, config);
        return;
      }
      if (interaction.isStringSelectMenu() && interaction.customId.startsWith("countdown:sound:")) {
        await handleSoundSelect(interaction, database, config.siteBaseUrl);
        return;
      }
      if (interaction.isModalSubmit() && interaction.customId.startsWith("countdown:custom:")) {
        await handleCustomModal(interaction, database, config);
      }
      } catch (error) {
        const userFacing =
          error instanceof InteractionError ||
          error instanceof DurationError ||
          error instanceof CountdownError ||
          error instanceof CountdownControlError;
        if (!userFacing) console.error("Interaction failed", error);
        const content = userFacing ? error.message : "Something went wrong while handling that countdown.";
        if (interaction.isRepliable()) {
          if (interaction.deferred && !interaction.replied) {
            await interaction.editReply({ content }).catch(() => undefined);
          } else if (interaction.replied) {
            await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
          } else {
            await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
          }
        }
      }
    })();
    active.add(job);
    void job.finally(() => active.delete(job)).catch(() => undefined);
    return job;
  };
  client.on("interactionCreate", listener);
  return {
    stop(): void {
      if (!accepting) return;
      accepting = false;
      client.off("interactionCreate", listener);
    },
    async drain(): Promise<void> {
      while (active.size > 0) await Promise.all([...active]);
    },
  };
}

async function handleAutocomplete(
  interaction: AutocompleteInteraction,
  database: CountdownDatabase,
  config: Pick<AppConfig, "defaultTimezone" | "countdownLimits">,
): Promise<void> {
  if (interaction.commandName === "countdown-manage") {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "countdown" || !interaction.guildId) {
      await interaction.respond([]);
      return;
    }
    const query = String(focused.value).trim().toLowerCase();
    const isAdministrator = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) === true;
    const channelAccess = new Map<string, Promise<boolean>>();
    const canManageChannel = (channelId: string): Promise<boolean> => {
      let access = channelAccess.get(channelId);
      if (!access) {
        const verification = hasCountdownChannelPermissionAsync(
          interaction.client.channels.cache.get(channelId),
          interaction.user.id,
          PermissionFlagsBits.ManageMessages,
        );
        // Autocomplete cannot be deferred. A slow permission lookup must fail
        // closed within its response budget, never fall back to stale access.
        access = new Promise<boolean>((resolve) => {
          const timeout = setTimeout(() => resolve(false), 2_000);
          void verification.then((allowed) => {
            clearTimeout(timeout);
            resolve(allowed);
          }, () => {
            clearTimeout(timeout);
            resolve(false);
          });
        });
        channelAccess.set(channelId, access);
      }
      return access;
    };
    const limits = config.countdownLimits ?? DEFAULT_COUNTDOWN_LIMITS;
    // An empty or very short query scans recent rows. A specific search scans
    // the active inventory locally so an older timer can be recovered even if
    // its card was deleted. Permission checks stay capped at 100 matches.
    const scanLimit = query.length >= 3 ? Math.min(limits.perGuild, limits.total) : 100;
    const matches = database.listActiveAll(interaction.guildId, Date.now(), scanLimit)
      .filter((countdown) => !query || countdown.title.toLowerCase().includes(query) || countdown.id.startsWith(query))
      .slice(0, 100);
    const permitted = await Promise.all(matches.map(async (countdown) => ({
      countdown,
      allowed: isAdministrator || countdown.creatorId === interaction.user.id ||
        database.isSubscribed(countdown.id, interaction.user.id) ||
        await canManageChannel(countdown.channelId),
    })));
    const values = permitted
      .filter(({ allowed }) => allowed)
      .map(({ countdown }) => countdown)
      .slice(0, 25)
      .map((countdown) => {
        const suffix = ` • ${countdown.id.slice(0, 8)}`;
        return {
          name: `${singleLineDiscordText(countdown.title, 100 - suffix.length)}${suffix}`,
          value: countdown.id,
        };
      });
    await interaction.respond(values);
    return;
  }

  if (interaction.commandName !== "countdown") {
    await interaction.respond([]);
    return;
  }
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "when") {
    await interaction.respond([]);
    return;
  }

  const typed = String(focused.value).trim();
  const query = typed.toLowerCase();
  const suggestions: Array<{ name: string; value: string }> = quickDurations
    .filter(({ name, value }) => !query || name.includes(query) || value.includes(query))
    .map(({ name, value }) => ({ name, value }));
  let validCustomValue = false;
  if (typed) {
    try {
      resolveCountdownTarget({
        when: typed,
        timezone: interaction.options.getString("timezone") || config.defaultTimezone,
      });
      validCustomValue = true;
    } catch {
      validCustomValue = false;
    }
  }
  if (validCustomValue && typed.length <= 64 && !suggestions.some(({ value }) => value === typed)) {
    suggestions.unshift({
      name: `Use “${singleLineDiscordText(typed, 100 - "Use “”".length)}”`,
      value: typed,
    });
  }
  await interaction.respond(suggestions.slice(0, 25));
}

async function handleCommand(
  interaction: ChatInputCommandInteraction,
  database: CountdownDatabase,
  config: HandlerConfig,
): Promise<void> {
  switch (interaction.commandName) {
    case "countdown": {
      const nowMs = Date.now();
      const when = interaction.options.getString("when")?.trim();
      if (!when) {
        const suppliedAdvancedOption = ["label", "timezone", "sound", "remind_before"]
          .some((name) => interaction.options.getString(name) !== null) ||
          interaction.options.getRole("notify_role") !== null;
        if (suppliedAdvancedOption) {
          throw new InteractionError("Add `when`, or run `/countdown` with no options to use the quick buttons.");
        }
        await showPresetPicker(interaction, database);
        break;
      }
      const target = resolveCountdownTarget({
        when,
        timezone: interaction.options.getString("timezone") || config.defaultTimezone,
      }, nowMs);
      await createCountdown(interaction, database, config, target, nowMs);
      break;
    }
    case "countdowns":
      await listCountdowns(interaction, database);
      break;
    case "countdown-manage":
      await manageCountdown(interaction, database, config.siteBaseUrl);
      break;
    case "countdown-help":
      await interaction.reply({ ...buildHelpMessage(config), flags: MessageFlags.Ephemeral });
      break;
    default:
      await interaction.reply({ content: "Unknown Countdown Bot command.", flags: MessageFlags.Ephemeral });
  }
}

async function createCountdown(
  interaction: ChatInputCommandInteraction,
  database: CountdownDatabase,
  config: Pick<AppConfig, "siteBaseUrl" | "countdownLimits">,
  target: ResolvedCountdownTarget,
  nowMs: number,
): Promise<void> {
  const soundValue = interaction.options.getString("sound") || "silent";
  if (!isSound(soundValue)) throw new InteractionError("That alert choice is not supported.");
  const requestedSound = soundValue;
  const notifyRole = interaction.options.getRole("notify_role") as Role | null;
  assertCanPostCountdown(interaction);
  const { countdown, voiceFallbackReason } = prepareCountdown(database, {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    messageId: null,
    creatorId: interaction.user.id,
    member: interaction.member instanceof GuildMember ? interaction.member : null,
    botMember: interaction.guild?.members.me ?? null,
    title: interaction.options.getString("label")?.trim() || "Countdown",
    requestedSound,
    customReminderInput: interaction.options.getString("remind_before")?.trim(),
    notifyRole,
    canMentionRole: interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) === true,
  }, target, nowMs, config.countdownLimits);
  let message;
  try {
    await interaction.deferReply();
    message = await interaction.fetchReply();
  } catch (error) {
    database.deleteDraftCountdown(countdown.id);
    throw error;
  }
  if (!database.armCountdown(countdown.id, message.id)) {
    database.deleteCountdown(countdown.id);
    throw new InteractionError("That countdown could not be activated. Please run the command again.");
  }
  const armedCountdown: StoredCountdown = {
    ...countdown,
    messageId: message.id,
    version: countdown.version + 1,
  };
  try {
    await interaction.editReply(buildCountdownCard(armedCountdown, config.siteBaseUrl));
    await reconcileCountdownCard(
      message,
      database,
      armedCountdown.id,
      armedCountdown.version,
      config.siteBaseUrl,
    );
  } catch (error) {
    if (isDefinitiveDiscordRejection(error) &&
      database.deleteRejectedCreation(armedCountdown.id, armedCountdown.version)) throw error;
    const repaired = await reconcileCountdownCard(
      message,
      database,
      armedCountdown.id,
      Number.NaN,
      config.siteBaseUrl,
    );
    if (!repaired) throw error;
  }

  if (voiceFallbackReason) {
    await interaction.followUp({
      content: `The countdown uses a text alert instead: ${voiceFallbackReason}`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

interface CountdownCreationSource {
  guildId: string | null;
  channelId: string | null;
  messageId: string | null;
  creatorId: string;
  member: GuildMember | null;
  botMember: GuildMember | null;
  title: string;
  requestedSound: Sound;
  customReminderInput: string | undefined;
  notifyRole: Role | null;
  canMentionRole: boolean;
}

function prepareCountdown(
  database: CountdownDatabase,
  source: CountdownCreationSource,
  target: ResolvedCountdownTarget,
  nowMs: number,
  limits: Readonly<CountdownLimits> = DEFAULT_COUNTDOWN_LIMITS,
): { countdown: StoredCountdown; voiceFallbackReason: string | null } {
  if (!source.guildId || !source.channelId) {
    throw new InteractionError("Countdowns can only be created in a server channel.");
  }
  if (database.countRecentCreations(source.guildId, source.creatorId, nowMs - 60_000) >= limits.creationsPerMinute) {
    throw new InteractionError(`Create at most ${limits.creationsPerMinute} countdowns per minute.`);
  }
  if (database.countActive(source.guildId, source.creatorId, nowMs) >= limits.perUser) {
    throw new InteractionError(`You can have up to ${limits.perUser} active countdowns in this server.`);
  }
  if (database.countActive(source.guildId, undefined, nowMs) >= limits.perGuild) {
    throw new InteractionError(`This server can have up to ${limits.perGuild} active countdowns.`);
  }
  if (database.countActiveGlobal(nowMs) >= limits.total) {
    throw new InteractionError("The bot is at its active countdown limit. Try again after a countdown finishes.");
  }
  if (source.notifyRole && !source.notifyRole.mentionable) {
    throw new InteractionError("That role is not mentionable. Make it mentionable or leave `notify_role` empty.");
  }
  if (source.notifyRole && !source.canMentionRole) {
    throw new InteractionError("Only a moderator with Manage Messages can create role alerts.");
  }

  const durationMs = target.endsAtMs - nowMs;
  const reminderOffsets = source.customReminderInput
    ? parseReminderOffsets(source.customReminderInput, durationMs)
    : smartReminderOffsets(durationMs);
  const reminderMode: ReminderMode = reminderOffsets.length ? "smart" : "off";
  const voice = resolveVoiceAlert(
    source.requestedSound,
    source.member?.voice.channel ?? null,
    source.botMember,
  );
  const { sound, voiceChannelId, fallbackReason: voiceFallbackReason } = voice;
  if (sound !== "silent") {
    if (database.countActiveAudible(source.guildId, source.creatorId, nowMs) >= MAX_AUDIBLE_COUNTDOWNS_PER_USER) {
      throw new InteractionError(`You can have up to ${MAX_AUDIBLE_COUNTDOWNS_PER_USER} active voice alerts.`);
    }
    if (database.countActiveAudible(source.guildId, null, nowMs) >= MAX_AUDIBLE_COUNTDOWNS_PER_GUILD) {
      throw new InteractionError(`This server can have up to ${MAX_AUDIBLE_COUNTDOWNS_PER_GUILD} active voice alerts.`);
    }
  }
  const countdown: StoredCountdown = {
    id: randomUUID(),
    guildId: source.guildId,
    channelId: source.channelId,
    messageId: source.messageId,
    creatorId: source.creatorId,
    title: source.title,
    kind: target.kind,
    state: "running",
    durationMs,
    remainingMs: durationMs,
    startedAtMs: nowMs,
    endsAtMs: target.endsAtMs,
    reminderMode,
    sound,
    voiceChannelId,
    mention: source.notifyRole ? `<@&${source.notifyRole.id}>` : `<@${source.creatorId}>`,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    version: 0,
  };

  database.createCountdown(countdown, reminderOffsets, { armed: false });
  return {
    countdown,
    voiceFallbackReason,
  };
}

export function buildPresetPicker(ownerId: string, selectedSound: Sound = "silent") {
  const durationRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...quickDurations.slice(0, 4).map(({ name, value }) =>
      new ButtonBuilder()
        .setCustomId(`countdown:preset:${ownerId}:${selectedSound}:${value}`)
        .setLabel(name)
        .setStyle(ButtonStyle.Secondary),
    ),
    new ButtonBuilder()
      .setCustomId(`countdown:preset:${ownerId}:${selectedSound}:custom`)
      .setLabel("Custom…")
      .setStyle(ButtonStyle.Primary),
  );
  const soundMenu = new StringSelectMenuBuilder()
    .setCustomId(`countdown:sound:${ownerId}`)
    .setPlaceholder("Choose the end alert")
    .addOptions(
      ...Object.entries(soundDetails).map(([value, details]) => ({
        label: details.label,
        description: details.description,
        emoji: details.emoji,
        value,
        default: value === selectedSound,
      })),
    );
  const soundRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(soundMenu);
  return {
    content: `Choose a duration. **End alert: ${soundDetails[selectedSound].label}.** Voice sounds play only at the end.`,
    components: [durationRow, soundRow],
    allowedMentions: { parse: [], repliedUser: false },
  };
}

async function showPresetPicker(
  interaction: ChatInputCommandInteraction,
  database: CountdownDatabase,
): Promise<void> {
  assertCanPostCountdown(interaction);
  await interaction.reply(buildPresetPicker(interaction.user.id));
  const message = await interaction.fetchReply();
  database.createPicker(message.id, interaction.user.id);
}

async function handleSoundSelect(
  interaction: StringSelectMenuInteraction,
  database: CountdownDatabase,
  siteBaseUrl: string,
): Promise<void> {
  const [, action, ownerId] = interaction.customId.split(":");
  if (action !== "sound" || !ownerId) throw new InteractionError("That alert selector is invalid.");
  if (ownerId !== interaction.user.id) {
    throw new InteractionError("Only the person who opened these quick buttons can change the alert.");
  }
  const selectedSound = interaction.values[0];
  if (!selectedSound || !isSound(selectedSound)) throw new InteractionError("That alert choice is not supported.");
  const updateToken = database.beginPickerSoundUpdate(interaction.message.id, ownerId, selectedSound);
  if (!updateToken) {
    throw new InteractionError("That quick countdown was already used or is being updated.");
  }
  let successful = false;
  let committed = false;
  let failure: unknown;
  try {
    await interaction.update(buildPresetPicker(ownerId, selectedSound));
    successful = true;
  } catch (error) {
    failure = error;
  } finally {
    committed = database.finishPickerSoundUpdate(
      interaction.message.id,
      ownerId,
      updateToken,
      successful,
    );
  }
  if (!committed || failure !== undefined) {
    await restorePickerOrCountdownMessage(interaction.message, database, ownerId, siteBaseUrl);
  }
  if (failure !== undefined) throw failure;
}

interface EditableCountdownMessage {
  id: string;
  edit(value: unknown): Promise<unknown>;
}

async function restorePickerOrCountdownMessage(
  message: EditableCountdownMessage,
  database: CountdownDatabase,
  ownerId: string,
  siteBaseUrl: string,
): Promise<boolean> {
  while (true) {
    const picker = database.getPickerDisplayState(message.id, ownerId);
    if (picker) {
      let edited = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await message.edit(buildPresetPicker(ownerId, picker.sound));
          edited = true;
          break;
        } catch {
          // A durable picker version check below prevents an older retry from
          // winning over a newer selection.
        }
      }
      if (!edited) return false;
      const after = database.getPickerDisplayState(message.id, ownerId);
      if (after?.version === picker.version) return true;
      continue;
    }

    const countdown = database.getCountdownByMessageId(message.id);
    if (!countdown) return false;
    await message.edit({ content: null, ...buildCountdownCard(countdown, siteBaseUrl) }).catch(() => undefined);
    await reconcileCountdownCard(message, database, countdown.id, countdown.version, siteBaseUrl);

    // The countdown can be atomically deleted and the picker reopened while
    // the card edit is in flight. Recheck ownership after the write so an old
    // card can never land on top of the restored picker.
    if (database.getPickerDisplayState(message.id, ownerId)) continue;
    return true;
  }
}

async function reconcileCountdownCard(
  message: EditableCountdownMessage,
  database: CountdownDatabase,
  countdownId: string,
  expectedVersion: number,
  siteBaseUrl: string,
): Promise<boolean> {
  let displayedVersion = expectedVersion;
  while (true) {
    const latest = database.getCountdown(countdownId);
    if (!latest) return true;
    if (latest.version === displayedVersion) {
      database.markCardSynchronized(countdownId, displayedVersion);
      return true;
    }
    let edited = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await message.edit({ content: null, ...buildCountdownCard(latest, siteBaseUrl) });
        edited = true;
        break;
      } catch {
        // Discord.js handles rate-limit waits. Retrying here covers transient
        // transport failures before the durable scheduler takes over.
      }
    }
    if (!edited) return false;
    displayedVersion = latest.version;
    const after = database.getCountdown(countdownId);
    if (after?.version === displayedVersion) {
      database.markCardSynchronized(countdownId, displayedVersion);
      return true;
    }
  }
}

async function listCountdowns(
  interaction: ChatInputCommandInteraction,
  database: CountdownDatabase,
): Promise<void> {
  if (!interaction.guildId) throw new InteractionError("This command is only available in servers.");
  const nowMs = Date.now();
  const scope = interaction.options.getString("scope") || "mine";
  const creatorId = scope === "mine" ? interaction.user.id : undefined;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const channelVisibility = new Map<string, Promise<boolean>>();
  const visible: StoredCountdown[] = [];
  // Scan newest first in bounded pages. Hidden channels can occupy an entire page,
  // so keep scanning until 20 visible entries or the server's active rows are exhausted.
  const pageSize = 100;
  for (let offset = 0; visible.length < 20; offset += pageSize) {
    const page = creatorId
      ? (offset === 0 ? database.listActive(interaction.guildId, creatorId, nowMs) : [])
      : database.listActiveAll(interaction.guildId, nowMs, pageSize, offset);
    if (page.length === 0) break;
    const accessible = await Promise.all(page.map(async (countdown) => {
      let access = channelVisibility.get(countdown.channelId);
      if (!access) {
        access = fetchCountdownChannel(interaction.client, countdown.channelId)
          .then((channel) => hasCountdownChannelPermissionAsync(channel, interaction.user.id));
        channelVisibility.set(countdown.channelId, access);
      }
      return await access ? countdown : null;
    }));
    for (const countdown of accessible) {
      if (countdown) visible.push(countdown);
      if (visible.length === 20) break;
    }
    if (page.length < pageSize) break;
  }
  if (visible.length === 0) {
    await interaction.editReply({ content: "No visible active countdowns found. Run `/countdown` for quick buttons." });
    return;
  }

  const displayed = visible.slice(0, 20);
  const lines = displayed.map((countdown) => {
    const status = countdown.state === "paused"
      ? `paused with ${formatDuration(countdown.remainingMs)} left`
      : `<t:${Math.floor((countdown.endsAtMs ?? 0) / 1_000)}:R>`;
    const jump = countdown.messageId
      ? `https://discord.com/channels/${countdown.guildId}/${countdown.channelId}/${countdown.messageId}`
      : null;
    const title = literalDiscordText(countdown.title);
    return `• ${jump ? `[${title}](${jump})` : `**${title}**`} · ${status}`;
  });
  if (displayed.length === 20) {
    lines.push("_Showing the newest 20 visible countdowns._");
  }
  const chunks = chunkDiscordLines(lines);
  const firstChunk = chunks[0] ?? "No countdowns found.";
  await interaction.editReply({ content: firstChunk, allowedMentions: { parse: [], repliedUser: false } });
  for (const content of chunks.slice(1)) {
    await interaction.followUp({ content, allowedMentions: { parse: [], repliedUser: false }, flags: MessageFlags.Ephemeral });
  }
}

export function chunkDiscordLines(lines: readonly string[], maxLength = 1_900): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    if (line.length > maxLength) throw new InteractionError("A countdown list entry is too long to display safely.");
    const next = current ? `${current}\n${line}` : line;
    if (next.length <= maxLength) {
      current = next;
    } else {
      if (current) chunks.push(current);
      current = line;
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : ["No countdowns found."];
}

async function manageCountdown(
  interaction: ChatInputCommandInteraction,
  database: CountdownDatabase,
  siteBaseUrl: string,
): Promise<void> {
  if (!interaction.guildId) throw new InteractionError("This command is only available in servers.");
  const countdownId = interaction.options.getString("countdown", true);
  const action = interaction.options.getString("action", true);
  const countdown = database.getCountdown(countdownId);
  if (!countdown || countdown.guildId !== interaction.guildId) {
    throw new InteractionError("That countdown is no longer available in this server.");
  }
  if (action === "unsubscribe") {
    database.setSubscription(countdown.id, interaction.user.id, false);
    await interaction.reply({
      // Unsubscribe must work after access is lost, without revealing the title.
      content: "🔕 Your reminders for that countdown are off.",
      allowedMentions: { parse: [], repliedUser: false },
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!isCountdownControlAction(action)) throw new InteractionError("That management action is not supported.");
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const targetChannel = await fetchCountdownChannel(interaction.client, countdown.channelId);
  const canControl = interaction.user.id === countdown.creatorId ||
    await hasCountdownChannelPermissionAsync(
      targetChannel,
      interaction.user.id,
      PermissionFlagsBits.ManageMessages,
    ) ||
    (targetChannel === null &&
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) === true);
  if (!canControl) throw new InteractionError("Only the countdown creator or a moderator can manage it.");

  // Channel permission checks can involve network I/O. Reload after that gap so
  // an older command cannot overwrite a newer pause, cancel, or completion.
  const current = database.getCountdown(countdown.id);
  if (!current || current.guildId !== interaction.guildId) {
    throw new InteractionError("That countdown is no longer available in this server.");
  }
  const updated = applyCountdownControl(current, action, Date.now());
  if (!database.updateCountdown(updated)) {
    throw new InteractionError("That countdown changed while you were managing it. Try again.");
  }
  const committed = { ...updated, version: updated.version + 1 };

  let cardUpdated = false;
  if (committed.messageId && targetChannel && typeof targetChannel === "object") {
    try {
      if ("isTextBased" in targetChannel && typeof targetChannel.isTextBased === "function" &&
        targetChannel.isTextBased() && "messages" in targetChannel) {
        const channel = targetChannel as {
          messages: { fetch(messageId: string): Promise<EditableCountdownMessage> };
        };
        const message = await channel.messages.fetch(committed.messageId);
        cardUpdated = await reconcileCountdownCard(
          message,
          database,
          committed.id,
          Number.NaN,
          siteBaseUrl,
        );
      }
    } catch {
      // The management command is the recovery path when the original card or
      // channel no longer exists; the authoritative database update still won.
    }
  }
  await interaction.editReply({
    content: `${cardUpdated ? "Updated" : "Saved"} **${literalDiscordText(committed.title)}**: ${action}.`,
    allowedMentions: { parse: [], repliedUser: false },
  });
}

export function buildHelpMessage(config: Omit<HandlerConfig, "defaultTimezone">) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Countdown Bot")
    .setDescription("Countdowns and reminders for your Discord server.")
    .addFields(
      { name: "Fastest", value: "Run `/countdown`, then tap 5 minutes, 10 minutes, 30 minutes, or 1 hour." },
      { name: "Quick countdown", value: "`/countdown when:5 minutes label:Pizza`\nShort form: `/countdown when:5m`" },
      { name: "Event countdown", value: `\`/countdown when:${exampleEventWhen()} timezone:Europe/Madrid\`` },
      { name: "Custom milestones", value: "Add `remind_before:7d, 1d, 1h, 10m`. Smart milestones are the default." },
      { name: "End alert", value: "A text notification is always sent. Text only (no beep) is the default; join voice to add Beep, Bell, or Urgent." },
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel("Open online countdown")
      .setStyle(ButtonStyle.Link)
      .setURL(buildOnlineCountdownLandingUrl(config.siteBaseUrl, "help")),
  );
  if (config.supportServerUrl) {
    row.addComponents(new ButtonBuilder().setLabel("Support").setStyle(ButtonStyle.Link).setURL(config.supportServerUrl));
  }
  if (config.privacyPolicyUrl) {
    row.addComponents(new ButtonBuilder().setLabel("Privacy").setStyle(ButtonStyle.Link).setURL(config.privacyPolicyUrl));
  }
  return { embeds: [embed], components: [row] };
}

async function handleButton(
  interaction: ButtonInteraction,
  database: CountdownDatabase,
  config: Pick<AppConfig, "siteBaseUrl" | "defaultTimezone" | "countdownLimits">,
): Promise<void> {
  const [, action, id] = interaction.customId.split(":");
  if (!action || !id) throw new InteractionError("That countdown control is invalid.");
  if (action === "preset") {
    await handlePresetButton(interaction, database, config);
    return;
  }
  const countdown = database.getCountdown(id);
  if (!countdown) throw new InteractionError("That countdown is no longer available.");
  if (interaction.guildId !== countdown.guildId) {
    throw new InteractionError("That countdown control belongs to another server.");
  }
  const boundToStoredCard = interaction.channelId === countdown.channelId &&
    interaction.message.id === countdown.messageId;

  if (action === "subscribe" || action === "unsubscribe") {
    if (action === "subscribe" && !boundToStoredCard) {
      throw new InteractionError("That reminder button is stale. Open the current countdown card.");
    }
    if (countdown.state === "completed" || countdown.state === "cancelled") {
      throw new InteractionError("That countdown has already ended.");
    }
    const alreadySubscribed = database.isSubscribed(countdown.id, interaction.user.id);
    if (action === "subscribe" && !alreadySubscribed &&
      database.countSubscribers(countdown.id) >= MAX_SUBSCRIBERS_PER_COUNTDOWN) {
      throw new InteractionError(`This countdown has reached its ${MAX_SUBSCRIBERS_PER_COUNTDOWN}-subscriber limit.`);
    }
    const changed = database.setSubscription(
      countdown.id,
      interaction.user.id,
      action === "subscribe",
      Date.now(),
      action === "subscribe" ? countdown.version : undefined,
    );
    const subscribed = action === "subscribe";
    if (subscribed && !changed && !database.isSubscribed(countdown.id, interaction.user.id)) {
      const latest = database.getCountdown(countdown.id);
      if (!latest || latest.state === "completed" || latest.state === "cancelled") {
        throw new InteractionError("That countdown has already ended.");
      }
      throw new InteractionError("That countdown changed while you were subscribing. Try again.");
    }
    const title = literalDiscordText(countdown.title);
    const row = subscribed
      ? new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`countdown:unsubscribe:${countdown.id}`)
            .setLabel("Turn off reminders")
            .setStyle(ButtonStyle.Secondary),
        )
      : null;
    await interaction.reply({
      content: subscribed
        ? changed
          ? `🔔 You will receive direct reminders for **${title}**.`
          : `🔔 Direct reminders for **${title}** were already on.`
        : changed
          ? `🔕 Reminders for **${title}** are off.`
          : `🔕 Reminders for **${title}** were already off.`,
      allowedMentions: { parse: [], repliedUser: false },
      ...(row ? { components: [row] } : {}),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!boundToStoredCard) {
    throw new InteractionError("That countdown control is stale or belongs to a different message.");
  }

  const canControl = interaction.user.id === countdown.creatorId ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) === true;
  if (!canControl) throw new InteractionError("Only the countdown creator or a moderator can use that control.");
  if (!isCountdownControlAction(action)) throw new InteractionError("That countdown control is not supported.");

  const updated = applyCountdownControl(countdown, action);
  if (!database.updateCountdown(updated)) {
    throw new InteractionError("That countdown changed while you were using its controls. Try again.");
  }
  const committed = { ...updated, version: updated.version + 1 };
  try {
    await interaction.update(buildCountdownCard(committed, config.siteBaseUrl));
  } catch (error) {
    await reconcileCountdownCard(
      interaction.message,
      database,
      committed.id,
      Number.NaN,
      config.siteBaseUrl,
    );
    throw error;
  }
  await reconcileCountdownCard(
    interaction.message,
    database,
    committed.id,
    committed.version,
    config.siteBaseUrl,
  );
}

async function handlePresetButton(
  interaction: ButtonInteraction,
  database: CountdownDatabase,
  config: Pick<AppConfig, "siteBaseUrl" | "defaultTimezone" | "countdownLimits">,
): Promise<void> {
  const [, , ownerId, soundOrValue, currentValue] = interaction.customId.split(":");
  const value = currentValue ?? soundOrValue;
  if (!ownerId || !value) throw new InteractionError("That quick countdown button is invalid.");
  const displayedSound = currentValue === undefined
    ? undefined
    : soundOrValue && isSound(soundOrValue) ? soundOrValue : null;
  if (displayedSound === null) throw new InteractionError("That quick countdown alert is invalid.");
  if (ownerId !== interaction.user.id) {
    throw new InteractionError("Only the person who opened these quick buttons can choose the countdown.");
  }
  if (!database.hasPicker(interaction.message.id)) {
    throw new InteractionError("These quick buttons have expired. Run `/countdown` again.");
  }
  assertCanPostCountdown(interaction);

  if (value === "custom") {
    if (displayedSound === undefined && !database.isPickerOpen(interaction.message.id, ownerId)) {
      throw new InteractionError("That quick countdown was already used or is being updated.");
    }
    const modal = new ModalBuilder()
      .setCustomId(`countdown:custom:${ownerId}:${displayedSound ?? "legacy"}`)
      .setTitle("Custom countdown");
    const when = new TextInputBuilder()
      .setCustomId("when")
      .setLabel("When should it end?")
      .setPlaceholder(`5 minutes, 1h30m, or ${exampleEventWhen()}`)
      .setStyle(TextInputStyle.Short)
      .setMaxLength(64)
      .setRequired(true);
    const label = new TextInputBuilder()
      .setCustomId("label")
      .setLabel("What is it for? (optional)")
      .setPlaceholder("Game night")
      .setStyle(TextInputStyle.Short)
      .setMaxLength(100)
      .setRequired(false);
    const timezone = new TextInputBuilder()
      .setCustomId("timezone")
      .setLabel("Timezone for an event")
      .setPlaceholder("Europe/Madrid")
      .setValue(config.defaultTimezone)
      .setStyle(TextInputStyle.Short)
      .setMaxLength(64)
      .setRequired(false);
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(when),
      new ActionRowBuilder<TextInputBuilder>().addComponents(label),
      new ActionRowBuilder<TextInputBuilder>().addComponents(timezone),
    );
    await interaction.showModal(modal);
    return;
  }

  const nowMs = Date.now();
  const selectedSound = displayedSound ?? database.getPickerSoundIfOpen(interaction.message.id, ownerId, nowMs);
  if (!selectedSound) throw new InteractionError("That quick countdown was already used or is being updated.");
  const target = resolveCountdownTarget({ when: value, timezone: config.defaultTimezone }, nowMs);
  const { countdown, voiceFallbackReason } = prepareCountdown(database, {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    messageId: null,
    creatorId: interaction.user.id,
    member: interaction.member instanceof GuildMember ? interaction.member : null,
    botMember: interaction.guild?.members.me ?? null,
    title: "Countdown",
    requestedSound: selectedSound,
    customReminderInput: undefined,
    notifyRole: null,
    canMentionRole: false,
  }, target, nowMs, config.countdownLimits);
  const consumedSound = database.consumePicker(
    interaction.message.id,
    ownerId,
    nowMs,
    selectedSound,
    countdown.id,
  );
  if (consumedSound !== selectedSound) {
    database.deleteCountdown(countdown.id);
    await restorePickerOrCountdownMessage(interaction.message, database, ownerId, config.siteBaseUrl);
    throw new InteractionError("That quick countdown changed while it was being created. Please try again.");
  }
  const armedCountdown = {
    ...countdown,
    messageId: interaction.message.id,
    version: countdown.version + 1,
  };
  try {
    await interaction.update({ content: null, ...buildCountdownCard(armedCountdown, config.siteBaseUrl) });
    await reconcileCountdownCard(
      interaction.message,
      database,
      armedCountdown.id,
      armedCountdown.version,
      config.siteBaseUrl,
    );
  } catch (error) {
    const rolledBack = isDefinitiveDiscordRejection(error) &&
      database.deleteCountdownAndReopenPickerIfUnchanged(
        countdown.id,
        armedCountdown.version,
        interaction.message.id,
        ownerId,
        selectedSound,
        nowMs,
      );
    if (rolledBack) {
      await interaction.message.edit(buildPresetPicker(ownerId, selectedSound)).catch(() => undefined);
      throw error;
    }
    const repaired = await reconcileCountdownCard(
      interaction.message,
      database,
      armedCountdown.id,
      Number.NaN,
      config.siteBaseUrl,
    );
    if (!repaired) throw error;
  }
  if (voiceFallbackReason) {
    await interaction.followUp({
      content: `Text-only alert selected: ${voiceFallbackReason}`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function handleCustomModal(
  interaction: ModalSubmitInteraction,
  database: CountdownDatabase,
  config: Pick<AppConfig, "siteBaseUrl" | "defaultTimezone" | "countdownLimits">,
): Promise<void> {
  const [, action, ownerId, displayedSoundValue] = interaction.customId.split(":");
  if (action !== "custom" || !ownerId) throw new InteractionError("That custom countdown form is invalid.");
  if (ownerId !== interaction.user.id) throw new InteractionError("That custom countdown form belongs to someone else.");
  if (!interaction.isFromMessage()) throw new InteractionError("That custom countdown form has expired.");
  if (!database.hasPicker(interaction.message.id)) {
    throw new InteractionError("These quick buttons have expired. Run `/countdown` again.");
  }
  assertCanPostCountdown(interaction);

  const nowMs = Date.now();
  const when = interaction.fields.getTextInputValue("when").trim();
  const label = interaction.fields.getTextInputValue("label").trim() || "Countdown";
  const timezone = interaction.fields.getTextInputValue("timezone").trim() || config.defaultTimezone;
  const target = resolveCountdownTarget({ when, timezone }, nowMs);
  const displayedSound = displayedSoundValue && isSound(displayedSoundValue)
    ? displayedSoundValue
    : undefined;
  const soundValue = displayedSound ?? database.getPickerSoundIfOpen(interaction.message.id, ownerId, nowMs);
  if (!soundValue) throw new InteractionError("That custom countdown form was already submitted or expired.");
  const { countdown, voiceFallbackReason } = prepareCountdown(database, {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    messageId: null,
    creatorId: interaction.user.id,
    member: interaction.member instanceof GuildMember ? interaction.member : null,
    botMember: interaction.guild?.members.me ?? null,
    title: label,
    requestedSound: soundValue,
    customReminderInput: undefined,
    notifyRole: null,
    canMentionRole: false,
  }, target, nowMs, config.countdownLimits);
  const consumedSound = database.consumePicker(
    interaction.message.id,
    ownerId,
    nowMs,
    soundValue,
    countdown.id,
  );
  if (consumedSound !== soundValue) {
    database.deleteCountdown(countdown.id);
    await restorePickerOrCountdownMessage(interaction.message, database, ownerId, config.siteBaseUrl);
    throw new InteractionError("That custom countdown changed while it was being created. Please try again.");
  }
  const armedCountdown = {
    ...countdown,
    messageId: interaction.message.id,
    version: countdown.version + 1,
  };
  try {
    await interaction.update({ content: null, ...buildCountdownCard(armedCountdown, config.siteBaseUrl) });
    await reconcileCountdownCard(
      interaction.message,
      database,
      armedCountdown.id,
      armedCountdown.version,
      config.siteBaseUrl,
    );
  } catch (error) {
    const rolledBack = isDefinitiveDiscordRejection(error) &&
      database.deleteCountdownAndReopenPickerIfUnchanged(
        countdown.id,
        armedCountdown.version,
        interaction.message.id,
        ownerId,
        soundValue,
        nowMs,
      );
    if (rolledBack) {
      await interaction.message.edit(buildPresetPicker(ownerId, soundValue)).catch(() => undefined);
      throw error;
    }
    const repaired = await reconcileCountdownCard(
      interaction.message,
      database,
      armedCountdown.id,
      Number.NaN,
      config.siteBaseUrl,
    );
    if (!repaired) throw error;
  }
  if (voiceFallbackReason) {
    await interaction.followUp({
      content: `Text-only alert selected: ${voiceFallbackReason}`,
      flags: MessageFlags.Ephemeral,
    });
  }
}
