import { Readable } from "node:stream";
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type DiscordGatewayAdapterCreator,
  type VoiceConnection,
} from "@discordjs/voice";
import type { Guild } from "discord.js";
import type { Sound } from "../types.js";
import { createChimePcm } from "./chime.js";

export const MAX_VOICE_ALERT_LATENESS_MS = 300_000;

export interface VoiceAlert {
  guild: Guild;
  voiceChannelId: string;
  sound: Exclude<Sound, "silent">;
  dueAtMs: number;
}

export type VoiceAlertRunner = (
  guild: Guild,
  voiceChannelId: string,
  sound: Exclude<Sound, "silent">,
) => Promise<void>;

export type VoiceAlertErrorHandler = (error: unknown, alert: VoiceAlert) => void;

export type VoiceAlertResult =
  | { status: "played" }
  | { status: "expired" }
  | { status: "failed"; error: unknown };

export function createVoiceChimePlayer(): AudioPlayer {
  return createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
}

export async function playVoiceChime(
  guild: Guild,
  voiceChannelId: string,
  sound: Exclude<Sound, "silent">,
): Promise<void> {
  // Pausing without a Ready connection prevents a disconnect from consuming
  // the PCM locally and being mistaken for a successfully heard alert.
  const player = createVoiceChimePlayer();
  const interrupted = new AbortController();
  let connection: VoiceConnection | undefined;
  let failure: unknown;
  let cleaningUp = false;
  const fail = (error: unknown): void => {
    failure ??= error instanceof Error ? error : new Error(String(error));
    interrupted.abort(failure);
    if (!cleaningUp) {
      try {
        player.stop(true);
      } catch {
        // Preserve the original failure and let finally finish cleanup. An
        // error listener must never throw back into the networking callback.
      }
    }
  };
  const checkDestination = (): void => {
    if (cleaningUp || !connection) return;
    if (connection.joinConfig.channelId !== voiceChannelId ||
      connection.state.status === VoiceConnectionStatus.Destroyed) {
      fail(new Error("The bot left the countdown's captured voice channel."));
    }
  };
  const signal = (timeoutMs: number): AbortSignal =>
    AbortSignal.any([interrupted.signal, AbortSignal.timeout(timeoutMs)]);
  // Keep listeners for the whole attempt, not just the temporary entersState
  // waits. EventEmitter errors otherwise escape the promise and crash Node.
  player.on("error", fail);
  let joinedCapturedChannel = false;
  try {
    const adapterCreator: DiscordGatewayAdapterCreator = (methods) => guild.voiceAdapterCreator({
      ...methods,
      onVoiceStateUpdate(packet) {
        methods.onVoiceStateUpdate(packet);
        if (cleaningUp) return;
        if (packet.channel_id === voiceChannelId) {
          joinedCapturedChannel = true;
          return;
        }
        // Discord.js routes voice states by guild only, so the previous same-guild
        // chime's leave (channel_id null) can arrive after this adapter is
        // registered. Like the voice library, ignore null until our join is seen.
        if (packet.channel_id === null && !joinedCapturedChannel) return;
        // Intercept the actual gateway update synchronously, before the next
        // audio frame can be prepared for a channel chosen by a moderator move.
        fail(new Error("The bot left the countdown's captured voice channel."));
      },
    });
    connection = joinVoiceChannel({
      channelId: voiceChannelId,
      guildId: guild.id,
      adapterCreator,
      selfDeaf: true,
      selfMute: false,
    });
    connection.on("error", fail);
    connection.on("stateChange", checkDestination);
    checkDestination();
    if (failure) throw failure;
    await entersState(connection, VoiceConnectionStatus.Ready, signal(15_000));
    checkDestination();
    if (failure) throw failure;
    connection.subscribe(player);
    const resource = createAudioResource(Readable.from(createChimePcm(sound)), { inputType: StreamType.Raw });
    player.play(resource);
    await entersState(player, AudioPlayerStatus.Playing, signal(5_000));
    await entersState(player, AudioPlayerStatus.Idle, signal(15_000));
    await entersState(connection, VoiceConnectionStatus.Ready, signal(1_000));
    checkDestination();
  } catch (error) {
    failure ??= error;
  } finally {
    cleaningUp = true;
    try {
      player.stop(true);
    } catch (error) {
      failure ??= error;
    }
    try {
      if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
    } catch (error) {
      failure ??= error;
    } finally {
      connection?.off("stateChange", checkDestination);
      connection?.off("error", fail);
      player.off("error", fail);
    }
  }
  if (failure) throw failure;
}

/**
 * Runs voice alerts independently from the scheduler. Discord permits only one
 * active voice connection per guild, so alerts for the same guild are ordered
 * while alerts for different guilds can start concurrently.
 */
export class VoiceAlertQueue {
  private readonly guildTails = new Map<string, Promise<void>>();
  private readonly pending = new Set<Promise<void>>();
  private readonly slotWaiters: Array<() => void> = [];
  private activeSlots = 0;

  constructor(
    private readonly runner: VoiceAlertRunner = playVoiceChime,
    private readonly now: () => number = Date.now,
    private readonly onError: VoiceAlertErrorHandler = (error, alert) => {
      console.error("Voice alert failed", { guildId: alert.guild.id, error });
    },
    private readonly maxConcurrency = 5,
  ) {
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new RangeError("Voice concurrency must be a positive safe integer.");
    }
  }

  enqueue(alert: VoiceAlert): Promise<VoiceAlertResult> {
    const previous = this.guildTails.get(alert.guild.id) ?? Promise.resolve();
    const result = previous
      .catch(() => undefined)
      .then(() => this.run(alert));
    const task = result.then(() => undefined);

    this.guildTails.set(alert.guild.id, task);
    this.pending.add(task);
    void task
      .then(() => this.finish(alert.guild.id, task), () => this.finish(alert.guild.id, task))
      .catch(() => undefined);
    return result;
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  private async run(alert: VoiceAlert): Promise<VoiceAlertResult> {
    if (this.now() - alert.dueAtMs > MAX_VOICE_ALERT_LATENESS_MS) return { status: "expired" };
    await this.acquireSlot();
    try {
      if (this.now() - alert.dueAtMs > MAX_VOICE_ALERT_LATENESS_MS) return { status: "expired" };
      await this.runner(alert.guild, alert.voiceChannelId, alert.sound);
      return { status: "played" };
    } catch (error) {
      this.report(error, alert);
      return { status: "failed", error };
    } finally {
      this.releaseSlot();
    }
  }

  private async acquireSlot(): Promise<void> {
    if (this.activeSlots < this.maxConcurrency) {
      this.activeSlots += 1;
      return;
    }
    await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
  }

  private releaseSlot(): void {
    const next = this.slotWaiters.shift();
    if (next) {
      // Transfer this permit directly. Decrementing before the waiter resumes
      // would let a newly queued alert barge in and temporarily exceed the cap.
      next();
      return;
    }
    this.activeSlots -= 1;
  }

  private report(error: unknown, alert: VoiceAlert): void {
    try {
      this.onError(error, alert);
    } catch {
      // Error reporting must not turn a handled voice failure into an
      // unhandled rejection on a fire-and-forget queue.
    }
  }

  private finish(guildId: string, task: Promise<void>): void {
    this.pending.delete(task);
    if (this.guildTails.get(guildId) === task) this.guildTails.delete(guildId);
  }
}
