// Layout anchor & key-field localization engine.
//
// Pipeline: page parser (pages/blocks/direction/image digests) → OCR line
// aligner (line + repaired byte range → candidate blocks; contention and
// column-spanning lines stay open) → field extractor (dosage, frequency,
// unit, contraindication negation, population) → consistency checker
// (adjacency, section, image region) → high-risk-only review queue.

export * from './geometry';
export * from './image-digest';
export * from './document';
export * from './aligner';
export * from './fields';
export * from './consistency';
export * from './engine';
