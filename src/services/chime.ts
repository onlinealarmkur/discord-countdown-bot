import type { Sound } from "../types.js";

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
// Every chime is normalized to the same peak (about -10 dBFS), leaving headroom for Opus encoding.
const PEAK = 10_000;
const ATTACK_SECONDS = 0.006;
const RELEASE_SECONDS = 0.03;

/** A partial as [frequency ratio, level, decay time constant in seconds]. */
type Partial = readonly [ratio: number, level: number, decaySeconds: number];

interface Note {
  atSeconds: number;
  frequency: number;
  lengthSeconds: number;
  timbre: readonly Partial[];
}

// A soft, square-ish electronic beep: odd harmonics that fade faster than the fundamental.
const BEEP: readonly Partial[] = [[1, 1, 0.25], [3, 0.2, 0.15], [5, 0.07, 0.1], [7, 0.03, 0.075]];
// A struck metal bar, like a vibraphone: the 1 : 4 : 10 partials of a tuned bar; the upper ones fade first.
const BAR: readonly Partial[] = [[1, 1, 0.9], [3.99, 0.32, 0.22], [10.02, 0.08, 0.06]];
// An alarm-clock pip: odd harmonics make it buzzier and harder to miss, without being shrill.
const ALARM: readonly Partial[] = [[1, 1, 4], [3, 0.22, 4], [5, 0.08, 4]];

const B5 = 987.77;
const C6 = 1_046.5;
const E5 = 659.26;
const G5 = 783.99;

function notes(times: readonly number[], frequency: number, lengthSeconds: number, timbre: readonly Partial[]): Note[] {
  return times.map((atSeconds) => ({ atSeconds, frequency, lengthSeconds, timbre }));
}

const PATTERNS: Record<Exclude<Sound, "silent">, Note[]> = {
  // A kitchen-timer double beep, twice: "beep-beep ... beep-beep".
  beep: notes([0, 0.16, 0.62, 0.78], B5, 0.11, BEEP),
  // A rising E, G, C chime that resolves home, each note ringing into the next.
  bell: [
    { atSeconds: 0, frequency: E5, lengthSeconds: 1.5, timbre: BAR },
    { atSeconds: 0.16, frequency: G5, lengthSeconds: 1.5, timbre: BAR },
    { atSeconds: 0.32, frequency: C6, lengthSeconds: 1.5, timbre: BAR },
  ],
  // Four bursts of four fast alarm pips.
  urgent: [0, 0.62, 1.24, 1.86].flatMap((burst) =>
    notes([0, 0.11, 0.22, 0.33].map((pip) => burst + pip), C6, 0.065, ALARM)),
};

function renderNote(mix: Float32Array, note: Note): void {
  const start = Math.round(note.atSeconds * SAMPLE_RATE);
  const frames = Math.round(note.lengthSeconds * SAMPLE_RATE);
  for (let frame = 0; frame < frames; frame += 1) {
    const time = frame / SAMPLE_RATE;
    const remaining = note.lengthSeconds - time;
    // Raised-cosine edges, so no note starts or stops with a click.
    const attack = time < ATTACK_SECONDS ? 0.5 - 0.5 * Math.cos(Math.PI * time / ATTACK_SECONDS) : 1;
    const release = remaining < RELEASE_SECONDS ? 0.5 - 0.5 * Math.cos(Math.PI * remaining / RELEASE_SECONDS) : 1;
    let value = 0;
    for (const [ratio, level, decaySeconds] of note.timbre) {
      value += level * Math.exp(-time / decaySeconds) * Math.sin(2 * Math.PI * note.frequency * ratio * time);
    }
    mix[start + frame] = (mix[start + frame] ?? 0) + value * attack * release;
  }
}

export function createChimePcm(sound: Exclude<Sound, "silent">): Buffer {
  const pattern = PATTERNS[sound];
  const totalSeconds = Math.max(...pattern.map((note) => note.atSeconds + note.lengthSeconds));
  const mix = new Float32Array(Math.ceil(totalSeconds * SAMPLE_RATE));
  for (const note of pattern) renderNote(mix, note);
  const peak = mix.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  const samples = new Int16Array(mix.length * CHANNELS);
  for (let frame = 0; frame < mix.length; frame += 1) {
    const value = Math.round((mix[frame] ?? 0) / peak * PEAK);
    samples[frame * CHANNELS] = value;
    samples[frame * CHANNELS + 1] = value;
  }
  return Buffer.from(samples.buffer);
}
