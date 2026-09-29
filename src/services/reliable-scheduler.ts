import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import type { Client, Guild, MessageEditOptions, TextBasedChannel } from "discord.js";
import type { AppConfig } from "../config.js";
import {
  CountdownDatabase,
  type ClaimedSubscriberBatch,
} from "../database.js";
import { formatDuration } from "../domain/duration.js";
import { buildCountdownDestinationUrl } from "../domain/links.js";
import { buildCountdownCard } from "../discord/card.js";
import { deliveryNonce } from "../discord/delivery-nonce.js";
import { literalDiscordText } from "../discord/literal-text.js";
import { allowedMentions } from "../discord/mentions.js";
import type { StoredCountdown } from "../types.js";
import { MAX_VOICE_ALERT_LATENESS_MS, VoiceAlertQueue } from "./voice.js";

const THIRTY_DAYS_MS = 30 * 86_400_000;
const ONE_DAY_MS = 86_400_000;
const CLOCK_STEP_TOLERANCE_MS = 2_000;
const TEN_MINUTES_MS = 600_000;
const MAX_COMPLETION_RETRY_AGE_MS = ONE_DAY_MS;
const MAX_AUXILIARY_ATTEMPTS = 8;
const MAX_RETRY_DELAY_MS = 3_600_000;
const MAX_VOICE_BACKGROUND_JOBS = 25;

function retryDelayMs(attemptCount: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, 30_000 * 2 ** Math.min(attemptCount, 7));
}

function elapsedDeliveryTimeMs(tickAtMs: number, startedAtMs: number): number {
  return tickAtMs + Math.max(0, Date.now() - startedAtMs);
}

interface ClaimHeartbeat {
  claimAtMs(): number;
  stop(): void;
}

function startClaimHeartbeat(
  initialClaimAtMs: number,
  baseNowMs: number,
  renew: (claimAtMs: number, renewedAtMs: number) => boolean,
): ClaimHeartbeat {
  const startedAtMs = Date.now();
  let currentClaimAtMs = initialClaimAtMs;
  const interval = setInterval(() => {
    const renewedAtMs = elapsedDeliveryTimeMs(baseNowMs, startedAtMs);
    if (renewedAtMs <= currentClaimAtMs) return;
    try {
      if (renew(currentClaimAtMs, renewedAtMs)) currentClaimAtMs = renewedAtMs;
    } catch (error) {
      console.error("Failed to renew a countdown delivery claim", error);
    }
  }, 30_000);
  interval.unref();
  return {
    claimAtMs: () => currentClaimAtMs,
    stop: () => clearInterval(interval),
  };
}

async function runWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const errors: unknown[] = [];
  const run = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value !== undefined) {
        try {
          await worker(value);
        } catch (error) {
          errors.push(error);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, run));
  if (errors.length > 0) throw new AggregateError(errors, "One or more countdown deliveries failed.");
}

async function deleteSupersededMessage(
  message: { delete(): Promise<unknown> },
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await message.delete();
      return true;
    } catch {
      // Persisted retry is queued by the scheduler after the fast retries.
    }
  }
  return false;
}

function discordErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = Number((error as { code?: unknown }).code);
  return Number.isFinite(code) ? code : undefined;
}

function isUnknownDiscordResource(error: unknown): boolean {
  const code = discordErrorCode(error);
  return code === 10_003 || code === 10_008;
}

// Unknown User, and "Cannot send messages to this user" (DMs closed, blocked,
// or no shared server). Neither recovers by retrying.
const PERMANENT_DM_ERROR_CODES: ReadonlySet<number> = new Set([10_013, 50_007]);

type DirectMessageOutcome = "sent" | "retry" | "blocked";

// Unknown Channel, Missing Access, and Missing Permissions: the channel is gone or the bot lost access to it.
// Retrying only adds invalid requests toward Discord's IP ban.
const PERMANENT_CHANNEL_ERROR_CODES: ReadonlySet<number> = new Set([10_003, 50_001, 50_013]);

function isPermanentChannelError(error: unknown): boolean {
  const code = discordErrorCode(error);
  return code !== undefined && PERMANENT_CHANNEL_ERROR_CODES.has(code);
}

interface MainDeliveryResult {
  delivered: boolean;
  channelDelivered: boolean;
  creatorDmDelivered: boolean;
  creatorDmRequired: boolean;
  /** Neither the channel nor the creator can ever receive it: stop retrying. */
  undeliverable: boolean;
}

export class CountdownScheduler {
  private interval: NodeJS.Timeout | undefined;
  private readonly activeTicks = new Set<Promise<void>>();
  private readonly textJobs = new Map<string, Set<string>>();
  private clockAtMs: number | undefined;
  private clockStartedAtMs = Date.now();
  private lastPruneAt = 0;
  private claimsRecovered = false;
  private readonly backgroundJobs = new Set<Promise<void>>();

  constructor(
    private readonly client: Client,
    private readonly database: CountdownDatabase,
    private readonly config: Pick<AppConfig, "siteBaseUrl">,
    private readonly voiceQueue = new VoiceAlertQueue(),
  ) {}

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      void this.tick().catch((error) => console.error("Countdown scheduler tick failed", error));
    }, 1_000);
    this.interval.unref();
    void this.tick().catch((error) => console.error("Initial countdown scheduler tick failed", error));
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }

  async drain(): Promise<void> {
    const errors: unknown[] = [];
    while (this.activeTicks.size > 0) {
      for (const result of await Promise.allSettled([...this.activeTicks])) {
        if (result.status === "rejected") errors.push(result.reason);
      }
    }
    while (this.backgroundJobs.size > 0) await Promise.all([...this.backgroundJobs]);
    await this.voiceQueue.drain();
    if (errors.length > 0) throw new AggregateError(errors, "Failed while draining countdown deliveries.");
  }

  tick(nowMs = Date.now()): Promise<void> {
    // Keep logical time monotonic across overlapping ticks, but follow a real
    // backward clock step (NTP, VM migration); otherwise every deadline would
    // fire early by that step until the process restarts.
    const projectedMs = this.now();
    this.clockAtMs = this.clockAtMs === undefined || nowMs < projectedMs - CLOCK_STEP_TOLERANCE_MS
      ? nowMs
      : Math.max(nowMs, projectedMs);
    this.clockStartedAtMs = Date.now();
    // A pending REST request must not stop deadline finalization. Delivery
    // pools below bound overlapping ticks; SQLite claims serialize each target.
    const current = this.runTick(this.now()).finally(() => {
      this.activeTicks.delete(current);
    });
    this.activeTicks.add(current);
    return current;
  }

  private now(): number {
    return this.clockAtMs === undefined ? Date.now() : elapsedDeliveryTimeMs(this.clockAtMs, this.clockStartedAtMs);
  }

  private async deliverTextBatch(
    kind: string,
    ids: readonly string[],
    concurrency: number,
    worker: (id: string, nowMs: number) => Promise<void>,
  ): Promise<void> {
    let active = this.textJobs.get(kind);
    if (!active) {
      active = new Set<string>();
      this.textJobs.set(kind, active);
    }
    const pool = active;
    await runWithConcurrency(ids, concurrency, async (id) => {
      if (pool.has(id) || pool.size >= concurrency) return;
      pool.add(id);
      try {
        await worker(id, this.now());
      } finally {
        pool.delete(id);
      }
    });
  }

  private async runTick(nowMs: number): Promise<void> {
    const errors: unknown[] = [];
    const phase = async (work: () => void | Promise<void>): Promise<void> => {
      try {
        await work();
      } catch (error) {
        errors.push(error);
      }
    };

    await phase(() => {
      if (!this.claimsRecovered) {
        this.database.recoverFutureClaims(nowMs);
        this.claimsRecovered = true;
      }
      this.database.finalizeDueCountdowns(nowMs);
      this.queueNewVoiceAlerts(nowMs);
    });
    await phase(async () => this.deliverTextBatch(
      "completion",
      this.database.getPendingCompletions(this.now()).map(({ id }) => id),
      10,
      (id, at) => this.deliverCompletion(id, at),
    ));
    await phase(async () => {
      const reminderIds = [...new Set(
        this.database.getDueReminders(this.now()).map(({ countdown }) => countdown.id),
      )];
      await this.deliverTextBatch("reminder", reminderIds, 10, (id, at) => this.deliverReminder(id, at));
    });
    await phase(async () => this.deliverTextBatch(
      "subscriber",
      this.database.getDueSubscriberCountdownIds(this.now()),
      5,
      (id, at) => this.deliverSubscriberBatch(id, at),
    ));
    await phase(async () => this.deliverTextBatch(
      "card",
      this.database.getPendingCardUpdateIds(this.now()),
      5,
      (id, at) => this.deliverCardUpdate(id, at),
    ));
    await phase(async () => this.deliverTextBatch(
      "deletion",
      this.database.getPendingMessageDeletionIds(this.now()),
      5,
      (id, at) => this.deliverMessageDeletion(id, at),
    ));

    await phase(() => {
      if (nowMs - this.lastPruneAt >= 3_600_000) {
        this.database.pruneTerminal(
          nowMs - THIRTY_DAYS_MS,
          nowMs - TEN_MINUTES_MS,
          nowMs - ONE_DAY_MS,
        );
        this.lastPruneAt = nowMs;
      }
    });
    if (errors.length > 0) throw new AggregateError(errors, "One or more scheduler phases failed.");
  }

  private queueNewVoiceAlerts(nowMs: number): void {
    const available = Math.max(0, MAX_VOICE_BACKGROUND_JOBS - this.backgroundJobs.size);
    for (let index = 0; index < available; index += 1) {
      const countdown = this.database.claimNextVoiceAlert(nowMs);
      if (!countdown) break;
      this.trackBackground(this.enqueueVoiceAlert(countdown, nowMs));
    }
  }

  private async enqueueVoiceAlert(countdown: StoredCountdown, claimAtMs: number): Promise<void> {
    const lease = startClaimHeartbeat(claimAtMs, claimAtMs, (current, renewed) =>
      this.database.renewVoiceAlertClaim(countdown.id, current, renewed));
    const dueAtMs = countdown.endsAtMs ?? countdown.updatedAtMs;
    if (!countdown.voiceChannelId || countdown.sound === "silent") {
      this.database.releaseVoiceAlertClaim(countdown.id, lease.claimAtMs());
      lease.stop();
      return;
    }
    if (claimAtMs - dueAtMs > MAX_VOICE_ALERT_LATENESS_MS) {
      this.database.markVoiceAlertDelivered(countdown.id, lease.claimAtMs(), claimAtMs);
      lease.stop();
      return;
    }
    const deliveryStartedAtMs = Date.now();
    try {
      const guild = (await this.client.guilds.fetch(countdown.guildId)) as Guild;
      const enqueueAtMs = elapsedDeliveryTimeMs(claimAtMs, deliveryStartedAtMs);
      if (enqueueAtMs - dueAtMs > MAX_VOICE_ALERT_LATENESS_MS) {
        this.database.markVoiceAlertDelivered(countdown.id, lease.claimAtMs(), enqueueAtMs);
        return;
      }
      const result = await this.voiceQueue.enqueue({
        guild,
        voiceChannelId: countdown.voiceChannelId,
        sound: countdown.sound,
        dueAtMs,
      });
      if (result.status === "failed") throw result.error;
      this.database.markVoiceAlertDelivered(
        countdown.id,
        lease.claimAtMs(),
        elapsedDeliveryTimeMs(claimAtMs, deliveryStartedAtMs),
      );
    } catch (error) {
      const failureAtMs = elapsedDeliveryTimeMs(claimAtMs, deliveryStartedAtMs);
      if (failureAtMs - dueAtMs > MAX_VOICE_ALERT_LATENESS_MS) {
        this.database.markVoiceAlertDelivered(countdown.id, lease.claimAtMs(), failureAtMs);
      } else {
        const attemptCount = this.database.getVoiceAlertAttemptCount(countdown.id);
        this.database.scheduleVoiceAlertRetry(
          countdown.id,
          lease.claimAtMs(),
          failureAtMs + retryDelayMs(attemptCount),
        );
      }
      console.error("Voice alert attempt failed; a bounded retry was scheduled", {
        countdownId: countdown.id,
        error,
      });
    } finally {
      lease.stop();
    }
  }

  private trackBackground(job: Promise<void>): void {
    const tracked = job.catch((error) => console.error("Countdown background delivery failed", error));
    this.backgroundJobs.add(tracked);
    void tracked.finally(() => this.backgroundJobs.delete(tracked)).catch(() => undefined);
  }

  private async deliverCompletion(countdownId: string, nowMs: number): Promise<void> {
    const countdown = this.database.claimCompletion(countdownId, nowMs);
    if (!countdown) return;
    const lease = startClaimHeartbeat(nowMs, nowMs, (current, renewed) =>
      this.database.renewCountdownDeliveryClaim(countdown.id, current, renewed));
    try {
      const overdueByMs = nowMs - (countdown.endsAtMs ?? nowMs);
      if (overdueByMs >= MAX_COMPLETION_RETRY_AGE_MS) {
        console.error("Abandoning an undeliverable completion after its retry window expired", {
          countdownId: countdown.id,
        });
        this.database.markCompletionDelivered(countdown.id, lease.claimAtMs(), nowMs);
        return;
      }

      const deliveryStartedAtMs = Date.now();
      const result = await this.sendCompletion(
        countdown,
        nowMs,
        () => this.database.isCountdownDeliveryClaimActive(countdown.id, lease.claimAtMs()),
      );
      const deliveryAtMs = elapsedDeliveryTimeMs(nowMs, deliveryStartedAtMs);
      if (result.delivered) {
        if (result.creatorDmRequired && !result.creatorDmDelivered && result.channelDelivered) {
          this.database.queueSubscriberRetry(
            countdown.id,
            countdown.creatorId,
            [0],
            deliveryAtMs + retryDelayMs(0),
          );
        }
        this.database.markCompletionDelivered(
          countdown.id,
          lease.claimAtMs(),
          deliveryAtMs,
          result.creatorDmDelivered ? countdown.creatorId : null,
          nowMs,
        );
        return;
      }

      if (result.undeliverable) {
        console.error("Abandoning a completion: its channel is gone and the creator's DMs are closed", {
          countdownId: countdown.id,
        });
        this.database.markCompletionDelivered(countdown.id, lease.claimAtMs(), deliveryAtMs);
        return;
      }
      const attemptCount = this.database.getCompletionAttemptCount(countdown.id);
      this.database.scheduleCompletionRetry(
        countdown.id,
        lease.claimAtMs(),
        deliveryAtMs + retryDelayMs(attemptCount),
      );
    } finally {
      lease.stop();
    }
  }

  private async sendCompletion(
    countdown: StoredCountdown,
    nowMs: number,
    canSend: () => boolean,
  ): Promise<MainDeliveryResult> {
    // A persisted subscriber DM already told the creator. It must only replace
    // the creator-DM fallback, never the channel alert everyone else relies on.
    const creatorAlreadyNotified = this.database.hasSuccessfulSubscriberDelivery(countdown.id, countdown.creatorId, [0]);
    const completed: StoredCountdown = {
      ...countdown,
      state: "completed",
      remainingMs: 0,
      endsAtMs: countdown.endsAtMs ?? nowMs,
      updatedAtMs: nowMs,
    };
    const content = `⏰ **Time's up: ${literalDiscordText(completed.title)}**`;
    let channel: TextBasedChannel | null = null;
    let channelDelivered = false;
    let channelGone = false;
    try {
      if (!canSend()) {
        return {
          delivered: false,
          channelDelivered: false,
          creatorDmDelivered: false,
          creatorDmRequired: completed.mention.startsWith("<@&"),
          undeliverable: false,
        };
      }
      channel = await this.fetchTextChannel(completed);
      channelGone = !channel || !("send" in channel);
      if (channel && "send" in channel && canSend()) {
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setLabel("Open live countdown")
            .setStyle(ButtonStyle.Link)
            .setURL(buildCountdownDestinationUrl(this.config.siteBaseUrl, completed, "time-up")),
        );
        const sent = await channel.send({
          content: `${completed.mention} ${content}`,
          allowedMentions: allowedMentions(completed),
          components: [row],
          nonce: deliveryNonce("channel", "completion", completed.id),
          enforceNonce: true,
        });
        if (!canSend()) {
          await this.deleteOrQueueSupersededMessage(sent, completed.channelId, nowMs, {
            countdownId: completed.id,
            delivery: "completion",
          });
          return {
            delivered: false,
            channelDelivered: false,
            creatorDmDelivered: false,
            creatorDmRequired: completed.mention.startsWith("<@&"),
            undeliverable: false,
          };
        }
        channelDelivered = true;
      }
    } catch (error) {
      channelGone = isPermanentChannelError(error);
      console.error("Failed to send completed countdown to its channel", { countdownId: completed.id, error });
    }
    const creatorShouldAlsoReceiveDm = completed.mention.startsWith("<@&");
    const dmOutcome = creatorAlreadyNotified || (channelDelivered && !creatorShouldAlsoReceiveDm)
      ? null
      : await this.sendDirectMessage(
          completed,
          completed.creatorId,
          content,
          "time-up-fallback",
          deliveryNonce("dm", "completion", completed.id, completed.creatorId),
          canSend,
          nowMs,
        );
    const creatorDmDelivered = creatorAlreadyNotified || dmOutcome === "sent";
    return {
      delivered: channelDelivered || creatorDmDelivered,
      channelDelivered,
      creatorDmDelivered,
      creatorDmRequired: creatorShouldAlsoReceiveDm,
      undeliverable: !channelDelivered && channelGone && dmOutcome === "blocked",
    };
  }

  private async deliverReminder(countdownId: string, nowMs: number): Promise<void> {
    const delivery = this.database.claimReminderDelivery(countdownId, nowMs);
    if (!delivery) return;
    const offsets = delivery.reminders.map(({ offsetMs }) => offsetMs);
    const lease = startClaimHeartbeat(delivery.claimAtMs, nowMs, (current, renewed) =>
      this.database.renewReminderDeliveryClaim(countdownId, offsets, current, renewed));
    try {
      const deliveryStartedAtMs = Date.now();
      const result = await this.sendMilestone(
        delivery.countdown,
        nowMs,
        offsets,
        () => this.now() < (delivery.countdown.endsAtMs ?? 0) && this.database.isReminderDeliveryClaimActive(
          countdownId,
          offsets,
          lease.claimAtMs(),
        ),
      );
      const deliveryAtMs = elapsedDeliveryTimeMs(nowMs, deliveryStartedAtMs);
      if (result.delivered) {
        if (result.creatorDmRequired && !result.creatorDmDelivered && result.channelDelivered) {
          this.database.queueSubscriberRetry(
            delivery.countdown.id,
            delivery.countdown.creatorId,
            offsets,
            deliveryAtMs + retryDelayMs(0),
          );
        }
        this.database.finishReminderDelivery(
          countdownId,
          offsets,
          lease.claimAtMs(),
          deliveryAtMs,
          result.creatorDmDelivered ? delivery.countdown.creatorId : null,
        );
        return;
      }

      const attemptCount = Math.max(...delivery.reminders.map(({ attemptCount: count }) => count));
      const nextAttemptAtMs = deliveryAtMs + retryDelayMs(attemptCount);
      const abandon = result.undeliverable || attemptCount + 1 >= MAX_AUXILIARY_ATTEMPTS ||
        nextAttemptAtMs >= (delivery.countdown.endsAtMs ?? nextAttemptAtMs);
      this.database.retryReminderDelivery(
        countdownId,
        offsets,
        lease.claimAtMs(),
        nextAttemptAtMs,
        abandon ? deliveryAtMs : null,
      );
    } finally {
      lease.stop();
    }
  }

  private async sendMilestone(
    countdown: StoredCountdown,
    nowMs: number,
    offsets: readonly number[],
    canSend: () => boolean,
  ): Promise<MainDeliveryResult> {
    const creatorAlreadyNotified = this.database.hasSuccessfulSubscriberDelivery(countdown.id, countdown.creatorId, offsets);
    const content = (): string => `⏳ **${literalDiscordText(countdown.title)}** has ${formatDuration(
      Math.max(0, (countdown.endsAtMs ?? nowMs) - this.now()),
    )} left.`;
    let channel: TextBasedChannel | null = null;
    let channelDelivered = false;
    let channelGone = false;
    try {
      if (!canSend()) {
        return {
          delivered: false,
          channelDelivered: false,
          creatorDmDelivered: false,
          creatorDmRequired: countdown.mention.startsWith("<@&"),
          undeliverable: false,
        };
      }
      channel = await this.fetchTextChannel(countdown);
      channelGone = !channel || !("send" in channel);
      if (channel && "send" in channel && canSend()) {
        const sent = await channel.send({
          content: `${countdown.mention} ${content()}`,
          allowedMentions: allowedMentions(countdown),
          nonce: deliveryNonce("channel", "reminder", countdown.id, ...offsets),
          enforceNonce: true,
        });
        if (!canSend()) {
          await this.deleteOrQueueSupersededMessage(sent, countdown.channelId, nowMs, {
            countdownId: countdown.id,
            delivery: "milestone",
          });
          return {
            delivered: false,
            channelDelivered: false,
            creatorDmDelivered: false,
            creatorDmRequired: countdown.mention.startsWith("<@&"),
            undeliverable: false,
          };
        }
        channelDelivered = true;
      }
    } catch (error) {
      channelGone = isPermanentChannelError(error);
      console.error("Failed to send countdown milestone to its channel", { countdownId: countdown.id, error });
    }
    const creatorShouldAlsoReceiveDm = countdown.mention.startsWith("<@&");
    const dmOutcome = creatorAlreadyNotified || (channelDelivered && !creatorShouldAlsoReceiveDm)
      ? null
      : await this.sendDirectMessage(
          countdown,
          countdown.creatorId,
          content,
          "milestone-fallback",
          deliveryNonce("dm", "reminder", countdown.id, countdown.creatorId, ...offsets),
          canSend,
          nowMs,
        );
    const creatorDmDelivered = creatorAlreadyNotified || dmOutcome === "sent";
    return {
      delivered: channelDelivered || creatorDmDelivered,
      channelDelivered,
      creatorDmDelivered,
      creatorDmRequired: creatorShouldAlsoReceiveDm,
      undeliverable: !channelDelivered && channelGone && dmOutcome === "blocked",
    };
  }

  private async deliverCardUpdate(countdownId: string, nowMs: number): Promise<void> {
    const countdown = this.database.claimCardUpdate(countdownId, nowMs);
    if (!countdown || !countdown.messageId) return;
    const lease = startClaimHeartbeat(nowMs, nowMs, (current, renewed) =>
      this.database.renewCountdownDeliveryClaim(countdown.id, current, renewed));
    const deliveryStartedAtMs = Date.now();
    try {
      const channel = await this.fetchTextChannel(countdown);
      if (!channel || !("messages" in channel)) throw new Error("The countdown channel is unavailable.");
      // The card ID is persisted. Editing by ID avoids an unnecessary GET for
      // every completion, which matters when many countdowns finish together.
      const message = {
        edit: (value: unknown) => channel.messages.edit(countdown.messageId!, value as MessageEditOptions),
      };
      await message.edit({ content: null, ...buildCountdownCard(countdown, this.config.siteBaseUrl) });
      const deliveryAtMs = elapsedDeliveryTimeMs(nowMs, deliveryStartedAtMs);
      if (!this.database.finishCardUpdate(countdown.id, lease.claimAtMs(), deliveryAtMs)) {
        await this.reconcileCardMessage(message, countdown.id, countdown.version, deliveryAtMs);
      }
    } catch (error) {
      const failureAtMs = elapsedDeliveryTimeMs(nowMs, deliveryStartedAtMs);
      const attemptCount = this.database.getCardUpdateAttemptCount(countdown.id);
      // A deleted card or a channel the bot lost access to never recovers by retrying.
      const abandon = isPermanentChannelError(error) || isUnknownDiscordResource(error) ||
        attemptCount + 1 >= MAX_AUXILIARY_ATTEMPTS ||
        failureAtMs - (countdown.endsAtMs ?? failureAtMs) >= MAX_COMPLETION_RETRY_AGE_MS;
      const retryScheduled = this.database.retryCardUpdate(
        countdown.id,
        lease.claimAtMs(),
        failureAtMs + retryDelayMs(attemptCount),
        abandon ? failureAtMs : null,
      );
      if (!retryScheduled) this.database.scheduleCardSynchronization(countdown.id, failureAtMs);
      console.error("Failed to synchronize countdown card", { countdownId: countdown.id, error });
    } finally {
      lease.stop();
    }
  }

  private async reconcileCardMessage(
    message: { edit(value: unknown): Promise<unknown> },
    countdownId: string,
    expectedVersion: number,
    nowMs: number,
  ): Promise<void> {
    let displayedVersion = expectedVersion;
    while (true) {
      const latest = this.database.getCountdown(countdownId);
      if (!latest) return;
      if (latest.version === displayedVersion) {
        this.database.markCardSynchronized(countdownId, displayedVersion, nowMs);
        return;
      }
      try {
        await message.edit({ content: null, ...buildCountdownCard(latest, this.config.siteBaseUrl) });
      } catch {
        this.database.scheduleCardSynchronization(countdownId, nowMs);
        return;
      }
      displayedVersion = latest.version;
    }
  }

  private async deliverSubscriberBatch(countdownId: string, nowMs: number): Promise<void> {
    const batch = this.database.claimSubscriberBatch(countdownId, nowMs);
    if (!batch) return;
    const lease = startClaimHeartbeat(batch.claimAtMs, nowMs, (current, renewed) =>
      this.database.renewSubscriberBatchClaim(countdownId, current, renewed));
    try {
      await runWithConcurrency(batch.groups, 5, async (group) => {
        await this.deliverSubscriberGroup(batch, group, nowMs, lease);
      });
    } finally {
      lease.stop();
      if (batch.locksCountdown) this.database.releaseSubscriberBatch(countdownId, lease.claimAtMs());
    }
  }

  private async deliverSubscriberGroup(
    batch: ClaimedSubscriberBatch,
    group: ClaimedSubscriberBatch["groups"][number],
    nowMs: number,
    lease: ClaimHeartbeat,
  ): Promise<void> {
    const completion = group.offsets.includes(0) || batch.countdown.state === "completed";
    if (completion && nowMs - (batch.countdown.endsAtMs ?? nowMs) >= MAX_COMPLETION_RETRY_AGE_MS) {
      this.database.retrySubscriberDelivery(
        batch.countdown.id,
        group.userId,
        group.offsets,
        lease.claimAtMs(),
        nowMs,
        nowMs,
      );
      return;
    }
    const content = (): string => completion
      ? `⏰ **Time's up: ${literalDiscordText(batch.countdown.title)}**`
      : `⏳ **${literalDiscordText(batch.countdown.title)}** has ${formatDuration(
        Math.max(0, (batch.countdown.endsAtMs ?? nowMs) - this.now()),
      )} left.`;
    const deliveryStartedAtMs = Date.now();
    const outcome = await this.sendDirectMessage(
      batch.countdown,
      group.userId,
      content,
      completion ? "subscriber-time-up" : "subscriber-milestone",
      deliveryNonce(
        "dm",
        completion ? "completion" : "reminder",
        batch.countdown.id,
        group.userId,
        ...(completion ? [] : group.offsets),
      ),
      () => (completion || this.now() < (batch.countdown.endsAtMs ?? 0)) && this.database.isSubscriberDeliveryClaimActive(
        batch.countdown.id,
        group.userId,
        group.offsets,
        lease.claimAtMs(),
      ),
      nowMs,
    );
    const deliveryAtMs = elapsedDeliveryTimeMs(nowMs, deliveryStartedAtMs);
    if (outcome === "sent") {
      this.database.finishSubscriberDelivery(
        batch.countdown.id,
        group.userId,
        group.offsets,
        lease.claimAtMs(),
        deliveryAtMs,
      );
      return;
    }
    const nextAttemptAtMs = deliveryAtMs + retryDelayMs(group.attemptCount);
    const tooOld = completion && deliveryAtMs - (batch.countdown.endsAtMs ?? deliveryAtMs) >= MAX_COMPLETION_RETRY_AGE_MS;
    const tooLate = !completion && nextAttemptAtMs >= (batch.countdown.endsAtMs ?? nextAttemptAtMs);
    const attemptsExhausted = !completion && group.attemptCount + 1 >= MAX_AUXILIARY_ATTEMPTS;
    // Retrying a closed DM only adds invalid requests toward Discord's IP ban.
    const abandon = outcome === "blocked" || attemptsExhausted || tooOld || tooLate;
    this.database.retrySubscriberDelivery(
      batch.countdown.id,
      group.userId,
      group.offsets,
      lease.claimAtMs(),
      nextAttemptAtMs,
      abandon ? deliveryAtMs : null,
    );
    // Later milestones would hit the same closed DMs.
    if (outcome === "blocked") this.database.removeUndeliverableSubscriber(batch.countdown.id, group.userId);
  }

  private async fetchTextChannel(countdown: StoredCountdown): Promise<TextBasedChannel | null> {
    const channel = await this.client.channels.fetch(countdown.channelId);
    return channel?.isTextBased() ? channel : null;
  }

  private async sendDirectMessage(
    countdown: StoredCountdown,
    userId: string,
    content: string | (() => string),
    campaign: string,
    nonce: string,
    canSend: () => boolean = () => true,
    logicalNowMs = Date.now(),
  ): Promise<DirectMessageOutcome> {
    try {
      if (!canSend()) return "retry";
      const user = await this.client.users.fetch(userId);
      if (!canSend()) return "retry";
      const sent = await user.send({
        content: typeof content === "function" ? content() : content,
        allowedMentions: { parse: [], repliedUser: false },
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setLabel("Open live countdown")
              .setStyle(ButtonStyle.Link)
              .setURL(buildCountdownDestinationUrl(this.config.siteBaseUrl, countdown, campaign)),
          ),
        ],
        nonce,
        enforceNonce: true,
      });
      if (!canSend()) {
        await this.deleteOrQueueSupersededMessage(
          sent,
          sent.channelId,
          logicalNowMs,
          { countdownId: countdown.id, delivery: "direct-message" },
        );
        return "retry";
      }
      return "sent";
    } catch (error) {
      const code = discordErrorCode(error);
      if (code !== undefined && PERMANENT_DM_ERROR_CODES.has(code)) {
        // Closed DMs are routine; keep the log short and never retry them.
        console.error("Direct message not deliverable", { countdownId: countdown.id, code });
        return "blocked";
      }
      console.error("Failed to send countdown direct message", { userId, error });
      return "retry";
    }
  }

  private async deleteOrQueueSupersededMessage(
    message: { id?: string; channelId?: string; delete(): Promise<unknown> },
    fallbackChannelId: string,
    nowMs: number,
    context: Record<string, string>,
  ): Promise<void> {
    if (await deleteSupersededMessage(message)) return;
    const messageId = message.id;
    const channelId = message.channelId || fallbackChannelId;
    if (messageId && channelId) {
      this.database.enqueueMessageDeletion(channelId, messageId, nowMs);
      return;
    }
    console.error("Failed to persist cleanup for a superseded countdown message", context);
  }

  private async deliverMessageDeletion(messageId: string, nowMs: number): Promise<void> {
    const deletion = this.database.claimMessageDeletion(messageId, nowMs);
    if (!deletion) return;
    try {
      const channel = await this.client.channels.fetch(deletion.channelId);
      if (!channel || !("messages" in channel)) throw new Error("The stale message channel is unavailable.");
      const message = await channel.messages.fetch(deletion.messageId);
      await message.delete();
      this.database.finishMessageDeletion(deletion.messageId, deletion.claimAtMs, nowMs);
    } catch (error) {
      if (isUnknownDiscordResource(error)) {
        this.database.finishMessageDeletion(deletion.messageId, deletion.claimAtMs, nowMs);
        return;
      }
      const abandon = deletion.attemptCount + 1 >= MAX_AUXILIARY_ATTEMPTS ||
        nowMs - deletion.createdAtMs >= MAX_COMPLETION_RETRY_AGE_MS;
      this.database.retryMessageDeletion(
        deletion.messageId,
        deletion.claimAtMs,
        nowMs + retryDelayMs(deletion.attemptCount),
        abandon ? nowMs : null,
      );
      console.error("Failed to delete a superseded countdown message", {
        messageId: deletion.messageId,
        error,
      });
    }
  }
}
