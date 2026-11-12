import type { Speaker, TranscriptLine } from "./protocol.ts";

/**
 * A live transcript in speaking order. Each speaker's unfinished caption
 * holds its place in the list and is replaced in place as the words change,
 * then settled there by the final line.
 */
export interface Transcript {
  /** Every line, oldest first, captions included. */
  readonly lines: readonly TranscriptLine[];
  /** Where each speaker's unfinished caption is in `lines`, if they have one. */
  readonly captions: Readonly<Partial<Record<Speaker, number>>>;
}

/** An empty transcript. */
export const EMPTY_TRANSCRIPT: Transcript = { lines: [], captions: {} };

/** The most lines a transcript keeps; older ones are dropped first. */
export const MAX_TRANSCRIPT_LINES = 500;

/**
 * Adds a line from the listen socket: a caption replaces the speaker's
 * current caption in place, or starts a new one; a final line settles it.
 *
 * @example
 * let transcript = EMPTY_TRANSCRIPT;
 * onTranscript: (line) => render((transcript = addTranscriptLine(transcript, line)).lines)
 */
export const addTranscriptLine = (transcript: Transcript, line: TranscriptLine, max: number = MAX_TRANSCRIPT_LINES): Transcript => {
  const keep = Number.isFinite(max) ? Math.max(1, Math.floor(max)) : MAX_TRANSCRIPT_LINES;
  let lines = [...transcript.lines];
  const captions: Partial<Record<Speaker, number>> = { ...transcript.captions };
  const at = captions[line.who];
  if (at === undefined) lines.push(line);
  else lines[at] = line;
  if (line.final) delete captions[line.who];
  else captions[line.who] = at ?? lines.length - 1;

  const over = lines.length - keep;
  if (over > 0) {
    lines = lines.slice(over);
    for (const who of Object.keys(captions) as Speaker[]) {
      const i = captions[who]! - over;
      if (i < 0) delete captions[who];
      else captions[who] = i;
    }
  }
  return { lines, captions };
};

/** Drops unfinished captions, which will never be settled (after a gap, or with the transcript switched off). */
export const dropCaptions = (transcript: Transcript): Transcript => {
  const open = new Set(Object.values(transcript.captions));
  return open.size ? { lines: transcript.lines.filter((_, i) => !open.has(i)), captions: {} } : transcript;
};
