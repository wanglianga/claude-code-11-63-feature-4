// Shared message protocol between the page and the diagnosis worker.

import type { AnalysisBundle, AnalysisParams } from '../types';

export interface WorkerAnalysisRequest {
  type: 'analyze';
  jobId: string;
  bytes: ArrayBuffer;
  digest: string;
  params: AnalysisParams;
}

export interface WorkerCancelRequest {
  type: 'cancel';
  jobId: string;
}

export type WorkerRequest = WorkerAnalysisRequest | WorkerCancelRequest;

export type WorkerResponse =
  | { type: 'progress'; jobId: string; stage: string; fraction: number; detail?: string }
  | { type: 'done'; jobId: string; bundle: AnalysisBundle; elapsedMs: number }
  | { type: 'error'; jobId: string; message: string }
  | { type: 'cancelled'; jobId: string };
