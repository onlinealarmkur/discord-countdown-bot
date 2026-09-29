import { unicodeGraphemes } from "../domain/unicode.js";

const CONTROL_OR_LINE_BREAK = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu;
const MARKDOWN_PUNCTUATION = /([\\`*_[\]{}()<>#+\-.!|~>])/gu;
const URL_SCHEME = /([a-z][a-z0-9+.-]*):\/\//giu;
const WWW_PREFIX = /\bwww\./giu;
const BROADCAST_MENTION = /@(everyone|here)\b/giu;
const DEFAULT_IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u;
const FORMAT_CONTROL = /^\p{Cf}$/u;
const VISUAL_BLANK = /^[\u2800\u3164\uffa0]$/u;

function shouldKeepCharacter(character: string, keepEmojiTag = false): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  if (keepEmojiTag && codePoint >= 0xe0020 && codePoint <= 0xe007f) return true;
  if (VISUAL_BLANK.test(character)) return false;
  if (FORMAT_CONTROL.test(character) && codePoint !== 0x200c && codePoint !== 0x200d) return false;
  if (!DEFAULT_IGNORABLE.test(character)) return true;
  return codePoint === 0x200c || codePoint === 0x200d ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef);
}

function fallbackText(maxLength: number): string {
  let result = "";
  for (const character of "Countdown") {
    if (result.length + character.length > maxLength) break;
    result += character;
  }
  return result;
}

function normalizeLiteralText(value: string): string {
  const normalized = unicodeGraphemes(value)
    .flatMap((grapheme) => {
      const characters = Array.from(grapheme);
      const subdivisionFlag = characters[0]?.codePointAt(0) === 0x1f3f4 &&
        characters.some((character) => character.codePointAt(0) === 0xe007f);
      return characters.filter((character) => shouldKeepCharacter(character, subdivisionFlag));
    })
    .join("")
    .replace(CONTROL_OR_LINE_BREAK, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const hasVisibleContent = Array.from(normalized).some((character) =>
    !DEFAULT_IGNORABLE.test(character) && !/^\s$/u.test(character));
  return hasVisibleContent ? normalized : "";
}

function escapeLiteralText(value: string): string {
  return value
    .replace(URL_SCHEME, "$1:\u200b//")
    .replace(WWW_PREFIX, (prefix) => `${prefix.slice(0, -1)}\u200b.`)
    .replace(BROADCAST_MENTION, "@\u200b$1")
    .replace(MARKDOWN_PUNCTUATION, "\\$1");
}

export function singleLineDiscordText(value: string, maxLength = 100): string {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1) {
    throw new RangeError("maxLength must be a positive safe integer.");
  }
  let result = "";
  for (const grapheme of unicodeGraphemes(normalizeLiteralText(value))) {
    if (result.length + grapheme.length > maxLength) break;
    result += grapheme;
  }
  return result || fallbackText(maxLength);
}

/**
 * Renders a user-authored label as one line of literal Discord text. This is
 * deliberately stricter than escapeMarkdown: labels must not become links,
 * headings, lists, mentions, timestamps, or other trusted bot-authored UI.
 */
export function literalDiscordText(value: string, maxLength = 200): string {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1) {
    throw new RangeError("maxLength must be a positive safe integer.");
  }

  const normalized = normalizeLiteralText(value);
  let raw = "";
  let escaped = "";
  for (const grapheme of unicodeGraphemes(normalized)) {
    const candidate = escapeLiteralText(raw + grapheme);
    if (candidate.length > maxLength) break;
    raw += grapheme;
    escaped = candidate;
  }
  return escaped || fallbackText(maxLength);
}
