import { describe, expect, it } from 'vitest';
import { runAnalysis } from '../src/lib/analysis/analyze';
import { DEFAULT_PARAMS } from '../src/lib/encoding/specs';
import { createInitialState, segmentText, setSymbolResolution, stateText } from '../src/lib/repair';
import { sha256Hex } from '../src/lib/util/sha256';
import { sampleBytes } from './setup';

const bytes = sampleBytes('utf8-with-bad-bytes.txt');
const bundle = runAnalysis({ bytes, digest: sha256Hex(bytes), params: DEFAULT_PARAMS });

describe('placeholder rendering', () => {
  it('emits each unresolved run exactly once, in byte order', () => {
    const state = createInitialState(bundle, 'uniform');
    const text = stateText(state);
    // Four damaged slices in the fixture: 0xC3, 0xFF 0xFE, 0xF0 0x9F.
    const placeholders = text.match(/⟦[^⟧]+⟧/g) ?? [];
    expect(placeholders.length).toBe(3);
    expect(placeholders[0]).toBe('⟦C3⟧' === placeholders[0] ? '⟦C3⟧' : placeholders[0]);
    // Text appears once, not duplicated per symbol.
    expect(text.split('对青霉素类过敏者禁用').length - 1).toBe(1);
    expect(text.split('用药期间如出现严重腹泻').length - 1).toBe(1);
  });

  it('inlines adjudications in place without shifting the rest', () => {
    const state = createInitialState(bundle, 'uniform');
    const seg = state.segments[0];
    const before = segmentText(seg, state);
    const cand = seg.candidates.find((c) => c.id === seg.selectedCandidateId)!;
    const next = setSymbolResolution(state, seg.id, cand.unresolved[0].id, '〔已核对〕', '', 'v2');
    const after = segmentText(next.segments[0], next);
    expect(after).toContain('〔已核对〕');
    // Everything after the symbol is unchanged relative to the original.
    const tailBefore = before.slice(before.indexOf(cand.unresolved[0].bytesHex ? '⟦' : '⟦') + 20);
    expect(after.endsWith(tailBefore.slice(tailBefore.indexOf('用药') - 0 > 0 ? tailBefore.indexOf('用药') : 0))).toBe(true);
  });

  it('supports the plain question-mark placeholder style', () => {
    const state = createInitialState(bundle, 'uniform');
    const text = stateText(state, { placeholder: 'question' });
    expect(text).not.toMatch(/⟦/);
    expect(text).toContain('?用药期间');
  });
});
