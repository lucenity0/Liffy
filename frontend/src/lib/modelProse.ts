/**
 * A run of N backticks opens a span and the next run of exactly N closes it,
 * which is CommonMark's rule and also the only part of it worth having here.
 *
 * The lookarounds are what enforce "exactly N" — without them the engine
 * backtracks a run of three down to a run of one and matches the two
 * backticks *beside* it, so an unclosed ``` renders as a code span containing
 * a backtick. With them an unmatched run stays literal: a fenced block the
 * model opened mid-sentence and never closed prints as three backticks and
 * the sentence around it survives, which is the failure mode to prefer.
 */
const SPAN = /(?<!`)(`+)(?!`)([\s\S]+?)(?<!`)\1(?!`)/g;

export function segments(text: string): { text: string; code: boolean }[] {
  const out: { text: string; code: boolean }[] = [];
  let last = 0;

  for (const match of text.matchAll(SPAN)) {
    const start = match.index;
    if (start > last) out.push({ text: text.slice(last, start), code: false });
    out.push({ text: match[2], code: true });
    last = start + match[0].length;
  }

  if (last < text.length) out.push({ text: text.slice(last), code: false });
  return out;
}
