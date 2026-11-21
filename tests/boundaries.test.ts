import { describe, expect, it } from 'vitest';
import {
  detectBracketFracture,
  detectTermFracture,
  detectUnitFracture,
  evaluateBoundaries,
  headUnits,
  tailUnits,
} from '../src/lib/analysis/boundaries';
import type { SegmentAnalysis } from '../src/types';

describe('unit fracture detection', () => {
  it('catches a split mg unit', () => {
    expect(detectUnitFracture('每日 10 m', 'g，每日一次')).toContain('mg');
  });

  it('catches split Chinese units', () => {
    expect(detectUnitFracture('每次 0.5 毫', '克，每日三次')).toContain('毫克');
    expect(detectUnitFracture('滴注 100 毫', '升')).toContain('毫升');
  });

  it('catches a split per-kilogram dose', () => {
    // "mg/kg" splits as "mg/k" | "g" → the "kg" unit is cut.
    expect(detectUnitFracture('按体重 50 mg/k', 'g 给药')).toContain('kg');
  });

  it('ignores a unit followed by a natural break', () => {
    expect(detectUnitFracture('每日 10 mg', '\n【适应症】')).toBeNull();
    expect(detectUnitFracture('剂量为 20', ' mg 每日一次')).toBeNull();
  });
});

describe('bracket fracture detection', () => {
  it('catches an unclosed bracket spanning the cut', () => {
    expect(detectBracketFracture('规格 0.5 g（按', '头孢曲松计）')).toContain('括号');
  });

  it('catches a closing bracket with no opener', () => {
    expect(detectBracketFracture('规格 0.5 g', '）')).toBeTruthy();
  });

  it('ignores balanced pairs', () => {
    expect(detectBracketFracture('规格（0.5 g）', '\n贮藏')).toBeNull();
  });
});

describe('term fracture detection', () => {
  it('catches a Han-Han split inside a word', () => {
    expect(detectTermFracture('注射用头孢', '曲松钠 1.0 g', true)).toContain('汉字');
  });

  it('catches a split Latin drug name', () => {
    expect(detectTermFracture('Ceftriax', 'one Sodium', true)).toContain('拉丁字母');
  });

  it('catches split digits', () => {
    expect(detectTermFracture('剂量 1', '0 mg', true)).toContain('数字');
  });

  it('allows a clean line break', () => {
    expect(detectTermFracture('每日一次。', '\n【禁忌】', false)).toBeNull();
  });
});

describe('unit extraction', () => {
  it('treats byte placeholders as single units', () => {
    expect(tailUnits('abc⟦2⟧', 2)).toEqual(['c', '⟦2⟧']);
    expect(headUnits('⟦2⟧def', 2)).toEqual(['⟦2⟧', 'd']);
  });
});

function fakeSegment(id: string, conf: number, text: string, encoding: 'gb18030' | 'big5' = 'gb18030'): SegmentAnalysis {
  return {
    id,
    start: 0,
    end: 100,
    kind: 'text',
    candidates: [
      {
        id: `c-${id}`,
        label: 'test',
        kind: 'direct',
        chain: [{ kind: 'decode', encoding }],
        encoding,
        glyphs: [],
        text,
        unresolved: [],
        score: {
          score: conf,
          anomalyRatio: 0,
          anomalyBytes: 0,
          suspiciousRatio: 0,
          mojibakeMarkerCount: 0,
          goodRatio: 1,
          lexiconHits: [],
          relativeLexiconBonus: 0,
          layerPenalty: 0,
          notes: [],
        },
        byteExact: true,
      },
    ],
    suggestedCandidateId: `c-${id}`,
    confidence: conf,
    margin: 0.3,
    status: 'confident',
    reasons: [],
    anomalyBytes: 0,
    suspiciousGlyphs: 0,
    detectedEncoding: encoding,
  };
}

describe('boundary evaluation', () => {
  it('caps combined confidence and raises a review for a split unit', () => {
    const left = fakeSegment('l', 0.95, '成人每次 0.5 m');
    const right = fakeSegment('r', 0.93, 'g，每日一次');
    const { reviews, caps } = evaluateBoundaries([{ boundary: 100, left, right }], { hasMixedEncodings: false });
    expect(reviews).toHaveLength(1);
    expect(reviews[0].severity).toBe('high');
    expect(reviews[0].combinedConfidence).toBeLessThan(0.7);
    expect(caps.get('l')?.confidence).toBeLessThan(0.7);
    expect(caps.get('r')?.confidence).toBeLessThan(0.7);
  });

  it('stays silent for a clean paragraph break', () => {
    const left = fakeSegment('l', 0.95, '每日一次。\n');
    const right = fakeSegment('r', 0.94, '\n【禁忌】');
    const { reviews } = evaluateBoundaries([{ boundary: 100, left, right }], { hasMixedEncodings: false });
    expect(reviews).toHaveLength(0);
  });

  it('flags differing candidate encodings as a medium risk', () => {
    const left = fakeSegment('l', 0.9, '注射用头孢曲松钠\n', 'gb18030');
    const right = fakeSegment('r', 0.88, '【不良反應】\n', 'big5');
    const { reviews } = evaluateBoundaries([{ boundary: 100, left, right }], { hasMixedEncodings: true });
    expect(reviews).toHaveLength(1);
    expect(reviews[0].severity).toBe('medium');
    expect(reviews[0].flags.join(' ')).toContain('编码');
  });
});
