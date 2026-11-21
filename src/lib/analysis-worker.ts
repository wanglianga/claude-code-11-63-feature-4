import type { AnalysisBundle, AnalysisParams } from '../types';
import type { WorkerRequest, WorkerResponse } from '../workers/protocol';

export interface AnalysisJobHandlers {
  onProgress?: (stage: string, fraction: number, detail?: string) => void;
}

export interface AnalysisJob {
  promise: Promise<{ bundle: AnalysisBundle; elapsedMs: number }>;
  cancel: () => void;
}

let worker: Worker | null = null;
const pending = new Map<
  string,
  {
    resolve: (v: { bundle: AnalysisBundle; elapsedMs: number }) => void;
    reject: (e: Error) => void;
    handlers: AnalysisJobHandlers;
  }
>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../workers/analysis.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      const job = pending.get(msg.jobId);
      if (!job) return;
      switch (msg.type) {
        case 'progress':
          job.handlers.onProgress?.(msg.stage, msg.fraction, msg.detail);
          break;
        case 'done':
          pending.delete(msg.jobId);
          job.resolve({ bundle: msg.bundle, elapsedMs: msg.elapsedMs });
          break;
        case 'error':
          pending.delete(msg.jobId);
          job.reject(new Error(msg.message));
          break;
        case 'cancelled':
          pending.delete(msg.jobId);
          job.reject(new DOMException('分析已取消', 'AbortError'));
          break;
      }
    };
    worker.onerror = (event) => {
      for (const [, job] of pending) job.reject(new Error(event.message || '分析 Worker 崩溃'));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  }
  return worker;
}

export function analyzeInWorker(
  bytes: Uint8Array,
  digest: string,
  params: AnalysisParams,
  handlers: AnalysisJobHandlers = {},
): AnalysisJob {
  const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const w = getWorker();
  // Copy into a transferable buffer: the caller keeps its own copy for the
  // repair workspace and IndexedDB.
  const copy = bytes.slice();
  const promise = new Promise<{ bundle: AnalysisBundle; elapsedMs: number }>((resolve, reject) => {
    pending.set(jobId, { resolve, reject, handlers });
    const request: WorkerRequest = {
      type: 'analyze',
      jobId,
      bytes: copy.buffer as ArrayBuffer,
      digest,
      params,
    };
    w.postMessage(request, [copy.buffer as ArrayBuffer]);
  });
  return {
    promise,
    cancel: () => {
      if (!pending.has(jobId)) return;
      getWorker().postMessage({ type: 'cancel', jobId } satisfies WorkerRequest);
    },
  };
}

export function terminateWorker(): void {
  worker?.terminate();
  worker = null;
  for (const [, job] of pending) job.reject(new DOMException('分析已取消', 'AbortError'));
  pending.clear();
}
