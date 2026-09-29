import { randomUUID } from "node:crypto";
import type { Guild } from "discord.js";
import {
  Networking,
  VoiceConnectionStatus,
  getVoiceConnection,
  type DiscordGatewayAdapterCreator,
} from "@discordjs/voice";
import { describe, expect, it, vi } from "vitest";
import { playVoiceChime } from "../src/services/voice.js";

// Real connection and player, fake Gateway/UDP transport. No Discord requests.
function playback(sound: "beep" | "urgent" = "beep", cleanupError = false) {
  const guildId = randomUUID();
  let gateway!: Parameters<DiscordGatewayAdapterCreator>[0];
  const guild = {
    id: guildId,
    voiceAdapterCreator: (methods: Parameters<DiscordGatewayAdapterCreator>[0]) => {
      gateway = methods;
      return {
        sendPayload: () => true,
        destroy: () => {
          if (cleanupError) connection.emit("error", new Error("cleanup network error"));
        },
      };
    },
  } as unknown as Guild;
  const result = playVoiceChime(guild, "captured-channel", sound)
    .then(() => ({ played: true, error: undefined }), (error: unknown) => ({ played: false, error }));
  const connection = getVoiceConnection(guildId)!;
  const frames = vi.fn();
  connection.prepareAudioPacket = frames;
  connection.dispatchAudio = vi.fn();
  connection.setSpeaking = vi.fn();
  return {
    connection, frames, result,
    ready: () => { connection.state = { ...connection.state, status: VoiceConnectionStatus.Ready } as never; },
    move: (channelId: string | null) => gateway.onVoiceStateUpdate({ channel_id: channelId } as never),
  };
}

describe("voice playback lifecycle", () => {
  it("plays and cleans up a successful chime", async () => {
    const app = playback();
    app.ready();
    expect(await app.result).toEqual({ played: true, error: undefined });
    expect(app.frames).toHaveBeenCalled();
    expect(app.connection.state.status).toBe(VoiceConnectionStatus.Destroyed);
    expect(app.connection.listenerCount("error")).toBe(0);
  });

  it.each([false, true])("contains network errors before/during playback (playing=%s)", async (playing) => {
    const app = playback("urgent");
    if (playing) {
      app.ready();
      await vi.waitFor(() => expect(app.frames).toHaveBeenCalled());
    }
    const error = new Error("synthetic UDP fault");
    expect(() => app.connection.emit("error", error)).not.toThrow();
    expect(await app.result).toEqual({ played: false, error });
    expect(app.connection.state.status).toBe(VoiceConnectionStatus.Destroyed);
    expect(app.connection.listenerCount("error")).toBe(0);
  });

  it.each([false, true])("rejects bot moves before/during playback (playing=%s)", async (playing) => {
    const app = playback("urgent");
    if (playing) {
      app.ready();
      await vi.waitFor(() => expect(app.frames).toHaveBeenCalled());
    }
    const before = app.frames.mock.calls.length;
    app.move("other-channel");
    expect(await app.result).toEqual({ played: false, error: expect.objectContaining({ message: expect.stringContaining("captured voice channel") }) });
    expect(app.frames).toHaveBeenCalledTimes(before);
  });

  it("ignores the previous same-guild chime's late leave packet", async () => {
    const app = playback("beep");
    app.move(null);
    app.move("captured-channel");
    app.ready();
    expect(await app.result).toEqual({ played: true, error: undefined });
    expect(app.frames).toHaveBeenCalled();
  });

  it("treats being disconnected after joining the captured channel as a failure", async () => {
    const app = playback("urgent");
    app.move("captured-channel");
    app.ready();
    await vi.waitFor(() => expect(app.frames).toHaveBeenCalled());
    app.move(null);
    expect(await app.result).toEqual({ played: false, error: expect.objectContaining({ message: expect.stringContaining("captured voice channel") }) });
  });

  it("contains errors emitted by transport cleanup", async () => {
    const app = playback("beep", true);
    app.ready();
    expect(await app.result).toEqual({ played: false, error: expect.objectContaining({ message: "cleanup network error" }) });
    expect(app.connection.listenerCount("error")).toBe(0);
  });
});

describe("installed voice transport encryption", () => {
  it.each(["aead_aes256_gcm_rtpsize", "aead_xchacha20_poly1305_rtpsize"])("encrypts actual packets with %s", async (mode) => {
    // This internal SDK boundary is intentional: PCM-only mocks missed the
    // missing provider. A library upgrade must keep this integration gate valid.
    const network = Networking.prototype as unknown as {
      encryptOpusPacket(packet: Buffer, data: unknown, header: Buffer): [Uint8Array, Uint8Array];
    };
    await vi.waitFor(() => {
      const data = { secretKey: new Uint8Array(32), encryptionMode: mode, nonce: 0,
        nonceBuffer: Buffer.alloc(mode.includes("aes") ? 12 : 24) };
      const [encrypted, nonce] = network.encryptOpusPacket(Buffer.from([1, 2, 3]), data, Buffer.alloc(12));
      expect(encrypted.length).toBeGreaterThan(3);
      expect(nonce).toHaveLength(4);
      expect(data.nonce).toBe(1);
    });
  });
});
