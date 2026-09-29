import type { Guild } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_VOICE_ALERT_LATENESS_MS,
  VoiceAlertQueue,
  type VoiceAlert,
  type VoiceAlertRunner,
} from "../src/services/voice.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function guild(id: string): Guild {
  return { id } as Guild;
}

function alert(guildId: string, voiceChannelId: string, dueAtMs = 1_000): VoiceAlert {
  return { guild: guild(guildId), voiceChannelId, sound: "beep", dueAtMs };
}

async function nextMicrotask(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("VoiceAlertQueue", () => {
  it("serializes alerts within one guild", async () => {
    const first = deferred();
    const events: string[] = [];
    const runner: VoiceAlertRunner = vi.fn(async (_guild, channelId) => {
      events.push(`start:${channelId}`);
      if (channelId === "voice-1") await first.promise;
      events.push(`end:${channelId}`);
    });
    const queue = new VoiceAlertQueue(runner, () => 1_000);

    queue.enqueue(alert("guild-1", "voice-1"));
    queue.enqueue(alert("guild-1", "voice-2"));
    await nextMicrotask();

    expect(events).toEqual(["start:voice-1"]);
    first.resolve();
    await queue.drain();
    expect(events).toEqual(["start:voice-1", "end:voice-1", "start:voice-2", "end:voice-2"]);
  });

  it("allows different guilds to play concurrently", async () => {
    const release = deferred();
    const started: string[] = [];
    const runner: VoiceAlertRunner = vi.fn(async (currentGuild) => {
      started.push(currentGuild.id);
      await release.promise;
    });
    const queue = new VoiceAlertQueue(runner, () => 1_000);

    queue.enqueue(alert("guild-1", "voice-1"));
    queue.enqueue(alert("guild-2", "voice-2"));
    await nextMicrotask();

    expect(started).toEqual(["guild-1", "guild-2"]);
    release.resolve();
    await queue.drain();
  });

  it("drops an alert if its turn starts more than five minutes late", async () => {
    const first = deferred();
    let nowMs = 1_000;
    const played: string[] = [];
    const runner: VoiceAlertRunner = vi.fn(async (_guild, channelId) => {
      played.push(channelId);
      if (channelId === "voice-1") await first.promise;
    });
    const queue = new VoiceAlertQueue(runner, () => nowMs);

    queue.enqueue(alert("guild-1", "voice-1"));
    queue.enqueue(alert("guild-1", "voice-too-late"));
    await nextMicrotask();
    nowMs = 1_000 + MAX_VOICE_ALERT_LATENESS_MS + 1;
    first.resolve();

    await queue.drain();
    expect(played).toEqual(["voice-1"]);
  });

  it("still starts an alert exactly five minutes late", async () => {
    const runner: VoiceAlertRunner = vi.fn(async () => undefined);
    const queue = new VoiceAlertQueue(runner, () => 1_000 + MAX_VOICE_ALERT_LATENESS_MS);

    queue.enqueue(alert("guild-1", "voice-at-boundary"));
    await queue.drain();

    expect(runner).toHaveBeenCalledOnce();
  });

  it("continues after a failure and handles rejections internally", async () => {
    const handledErrors: unknown[] = [];
    const played: string[] = [];
    const runner: VoiceAlertRunner = vi.fn(async (_guild, channelId) => {
      if (channelId === "voice-fails") throw new Error("voice unavailable");
      played.push(channelId);
    });
    const queue = new VoiceAlertQueue(runner, () => 1_000, (error) => handledErrors.push(error));

    queue.enqueue(alert("guild-1", "voice-fails"));
    queue.enqueue(alert("guild-1", "voice-recovers"));

    await expect(queue.drain()).resolves.toBeUndefined();
    expect(handledErrors).toHaveLength(1);
    expect(played).toEqual(["voice-recovers"]);
  });

  it("also contains a throwing error handler", async () => {
    const runner: VoiceAlertRunner = vi.fn(async () => {
      throw new Error("voice unavailable");
    });
    const queue = new VoiceAlertQueue(runner, () => 1_000, () => {
      throw new Error("logger unavailable");
    });

    queue.enqueue(alert("guild-1", "voice-1"));
    await expect(queue.drain()).resolves.toBeUndefined();
  });

  it("reports whether an alert played, expired, or failed", async () => {
    const error = new Error("voice unavailable");
    const queue = new VoiceAlertQueue(async (_guild, channelId) => {
      if (channelId === "failed") throw error;
    }, () => 1_000 + MAX_VOICE_ALERT_LATENESS_MS + 1, () => undefined);

    await expect(queue.enqueue(alert("guild-1", "expired"))).resolves.toEqual({ status: "expired" });
    await expect(queue.enqueue(alert(
      "guild-2",
      "failed",
      1_000 + MAX_VOICE_ALERT_LATENESS_MS + 1,
    ))).resolves.toEqual({ status: "failed", error });
  });

  it("caps simultaneous voice connections across guilds", async () => {
    const release = deferred();
    let active = 0;
    let peak = 0;
    const queue = new VoiceAlertQueue(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await release.promise;
      active -= 1;
    }, () => 1_000, undefined, 3);

    for (let index = 0; index < 8; index += 1) {
      void queue.enqueue(alert(`guild-${index}`, `voice-${index}`));
    }
    await nextMicrotask();
    expect(peak).toBe(3);
    release.resolve();
    await queue.drain();
  });

  it("transfers a released slot without allowing a new alert to barge past a waiter", async () => {
    const releaseFirst = deferred();
    const releaseFollowers = deferred();
    const started: string[] = [];
    let active = 0;
    let peak = 0;
    let queue: VoiceAlertQueue;
    const runner: VoiceAlertRunner = async (currentGuild) => {
      started.push(currentGuild.id);
      active += 1;
      peak = Math.max(peak, active);
      if (currentGuild.id === "guild-1") {
        await releaseFirst.promise;
        void queue.enqueue(alert("guild-3", "voice-3"));
      } else {
        await releaseFollowers.promise;
      }
      active -= 1;
    };
    queue = new VoiceAlertQueue(runner, () => 1_000, undefined, 1);

    void queue.enqueue(alert("guild-1", "voice-1"));
    void queue.enqueue(alert("guild-2", "voice-2"));
    await nextMicrotask();
    expect(started).toEqual(["guild-1"]);

    releaseFirst.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(started).toEqual(["guild-1", "guild-2"]);
    expect(peak).toBe(1);

    releaseFollowers.resolve();
    await queue.drain();
    expect(started).toEqual(["guild-1", "guild-2", "guild-3"]);
    expect(peak).toBe(1);
  });
});
