import { LEXICON_BLOB } from './lexicon-data';

export interface Lexicon {
  /** Ordered by frequency rank; index ≈ rank. */
  rank: Map<string, number>;
  /** Traditional char → simplified char for cross-script recognition. */
  cross: Map<string, string>;
  vocab: Set<string>;
  /** Multi-character pharmaceutical terms. */
  terms: string[];
  termMaxLen: number;
}

let cached: Lexicon | null = null;

export function getLexicon(): Lexicon {
  if (cached) return cached;
  const data = JSON.parse(LEXICON_BLOB) as {
    chars: string;
    cross: string;
    vocab: string;
    terms: string[];
  };
  const rank = new Map<string, number>();
  let i = 0;
  for (const ch of data.chars) rank.set(ch, i++);
  const cross = new Map<string, string>();
  for (let k = 0; k + 1 < data.cross.length; k += 2) {
    cross.set(data.cross[k], data.cross[k + 1]);
  }
  const vocab = new Set(data.vocab.split('\n'));
  const terms = [...data.terms].sort((a, b) => b.length - a.length);
  const termMaxLen = terms.reduce((m, t) => Math.max(m, t.length), 0);
  cached = { rank, cross, vocab, terms, termMaxLen };
  return cached;
}

/** Simplified form of a character when the lexicon knows a cross mapping. */
export function normalizeChar(lx: Lexicon, ch: string): string {
  return lx.cross.get(ch) ?? ch;
}
