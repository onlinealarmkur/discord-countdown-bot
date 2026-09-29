const graphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

function replaceLoneSurrogates(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && codePoint >= 0xd800 && codePoint <= 0xdfff
      ? "\ufffd"
      : character;
  }).join("");
}

/** Returns user-visible grapheme clusters without leaving malformed UTF-16. */
export function unicodeGraphemes(value: string): string[] {
  return Array.from(
    graphemeSegmenter.segment(replaceLoneSurrogates(value)),
    ({ segment }) => segment,
  );
}
