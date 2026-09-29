import { Readable } from "node:stream";
import {
  AudioPlayerStatus,
  StreamType,
  VoiceConnectionStatus,
  createAudioResource,
  entersState,
  type VoiceConnection,
} from "@discordjs/voice";
import { describe, expect, it, vi } from "vitest";
import { createChimePcm } from "../src/services/chime.js";
import { createVoiceChimePlayer } from "../src/services/voice.js";

describe("createChimePcm", () => {
  it.each(["beep", "bell", "urgent"] as const)("generates non-empty stereo PCM for %s", (sound) => {
    const data = createChimePcm(sound);
    expect(data.length).toBeGreaterThan(48_000);
    expect(data.length % 4).toBe(0);
    expect(data.some((byte) => byte !== 0)).toBe(true);
  });

  it("makes the urgent signal longer than the simple beep", () => {
    expect(createChimePcm("urgent").length).toBeGreaterThan(createChimePcm("beep").length);
  });

  it("keeps Beep, Bell, and Urgent audibly distinct", () => {
    const beep = createChimePcm("beep");
    const bell = createChimePcm("bell");
    const urgent = createChimePcm("urgent");

    expect(beep.equals(bell)).toBe(false);
    expect(beep.equals(urgent)).toBe(false);
    expect(bell.equals(urgent)).toBe(false);
    expect(beep.length).toBeLessThan(bell.length);
    expect(bell.length).toBeLessThan(urgent.length);
  });

  it.each(["beep", "bell", "urgent"] as const)(
    "produces balanced stereo without clipping for %s",
    (sound) => {
      const data = createChimePcm(sound);
      let peak = 0;
      let unbalancedFrames = 0;
      for (let offset = 0; offset < data.length; offset += 4) {
        const left = data.readInt16LE(offset);
        const right = data.readInt16LE(offset + 2);
        // Count here and assert once: a per-sample expect() makes this test time out under load.
        if (right !== left) unbalancedFrames += 1;
        peak = Math.max(peak, Math.abs(left));
      }
      expect(unbalancedFrames).toBe(0);
      expect(peak).toBeGreaterThan(6_000);
      expect(peak).toBeLessThan(12_000);
    },
  );

  it("loads the installed Opus encoder for the exact raw-PCM voice pipeline", () => {
    const resource = createAudioResource(Readable.from(createChimePcm("beep")), {
      inputType: StreamType.Raw,
    });
    expect(resource.playStream.constructor.name).toBe("Encoder");
    expect(resource.playStream.readable).toBe(true);
    resource.playStream.destroy();
  });

  it("pauses rather than consuming a chime while its voice connection is disconnected", async () => {
    const player = createVoiceChimePlayer();
    const connection = {
      state: { status: VoiceConnectionStatus.Ready },
      prepareAudioPacket: vi.fn(),
      dispatchAudio: vi.fn(),
      setSpeaking: vi.fn(),
    };
    (player as unknown as { subscribe(value: VoiceConnection): unknown })
      .subscribe(connection as unknown as VoiceConnection);
    const resource = createAudioResource(Readable.from(createChimePcm("beep")), {
      inputType: StreamType.Raw,
    });

    try {
      player.play(resource);
      await entersState(player, AudioPlayerStatus.Playing, 2_000);
      connection.state = { status: VoiceConnectionStatus.Disconnected };
      await entersState(player, AudioPlayerStatus.AutoPaused, 2_000);

      await new Promise<void>((resolve) => setTimeout(resolve, 750));
      expect(player.state.status).toBe(AudioPlayerStatus.AutoPaused);

      connection.state = { status: VoiceConnectionStatus.Ready };
      await entersState(player, AudioPlayerStatus.Playing, 2_000);
      await entersState(player, AudioPlayerStatus.Idle, 3_000);
      expect(connection.prepareAudioPacket).toHaveBeenCalled();
    } finally {
      player.stop(true);
    }
  });
});
