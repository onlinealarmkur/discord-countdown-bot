import type { StoredCountdown } from "../types.js";
import { unicodeGraphemes } from "./unicode.js";

const DISCORD_MAX_URL_LENGTH = 512;
const MAX_TITLE_GRAPHEMES = 80;

function discordSafeUrl(url: URL): string {
  const serialized = url.toString();
  if (serialized.length > DISCORD_MAX_URL_LENGTH) {
    throw new RangeError("The countdown URL base and attribution exceed Discord's 512-character limit.");
  }
  return serialized;
}

function trackedUrl(path: string, baseUrl: string, campaign: string): URL {
  const url = new URL(path, baseUrl);
  // Public countdown links use HTTPS, including older HTTP configuration.
  url.protocol = "https:";
  url.searchParams.set("utm_source", "discord");
  url.searchParams.set("utm_medium", "bot");
  url.searchParams.set("utm_campaign", campaign);
  return url;
}

export function buildOnlineCountdownUrl(
  baseUrl: string,
  endsAtMs: number,
  title: string,
  campaign = "countdown-card",
): string {
  const url = trackedUrl("/countdown/en/", baseUrl, campaign);
  const iso = new Date(endsAtMs).toISOString().slice(0, 19);
  const titleGraphemes = unicodeGraphemes(title).slice(0, MAX_TITLE_GRAPHEMES);
  let low = 0;
  let high = titleGraphemes.length;
  let result = "";

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const shortenedTitle = titleGraphemes.slice(0, middle).join("");
    // Match the website's share format: encode the title as a parameter, then
    // encode the entire fragment. The extra layer also keeps title delimiters
    // separate when the website decodes the fragment before parsing parameters.
    url.hash = encodeURIComponent(`${iso}&tz=UTC&title=${encodeURIComponent(shortenedTitle)}`);
    const candidate = url.toString();
    if (candidate.length <= DISCORD_MAX_URL_LENGTH) {
      result = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (!result) {
    throw new RangeError("The countdown URL base and attribution exceed Discord's 512-character limit.");
  }
  return result;
}

export function buildOnlineCountdownLandingUrl(baseUrl: string, campaign = "countdown-card"): string {
  return discordSafeUrl(trackedUrl("/countdown/en/", baseUrl, campaign));
}

export function buildCountdownDestinationUrl(
  baseUrl: string,
  countdown: StoredCountdown,
  campaign?: string,
): string {
  return countdown.endsAtMs === null
    ? buildOnlineCountdownLandingUrl(baseUrl, campaign ?? "countdown-card")
    : buildOnlineCountdownUrl(baseUrl, countdown.endsAtMs, countdown.title, campaign ?? "countdown-card");
}
