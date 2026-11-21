/// <reference lib="webworker" />
import { runAnalysis } from '../lib/analysis/analyze';
import type { WorkerRequest, WorkerResponse } from './protocol';

let cancelled = new Set<string>();

function post(message: WorkerResponse) {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message);
}

/**
 * The analysis is synchronous inside the engine; the worker reports coarse
 * progress around its two phases so the page can show movement on large files.
 */
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const data = event.data;
  if (data.type === 'cancel') {
    cancelled.add(data.jobId);
    post({ type: 'cancelled', jobId: data.jobId });
    return;
  }
  if (data.type !== 'analyze') return;

  const { jobId, digest, params } = data;
  const started = performance.now();
  try {
    post({ type: 'progress', jobId, stage: 'segment', fraction: 0.05, detail: '准备字节视图' });
    const bytes = new Uint8Array(data.bytes);
    if (cancelled.has(jobId)) {
      post({ type: 'cancelled', jobId });
      return;
    }
    post({ type: 'progress', jobId, stage: 'uniform', fraction: 0.2, detail: '评估统一解码路径' });
    // The engine runs both strategies; yield between phases so cancel messages
    // and progress updates are actually delivered.
    setTimeout(() => {
      try {
        if (cancelled.has(jobId)) {
          post({ type: 'cancelled', jobId });
          return;
        }
        post({ type: 'progress', jobId, stage: 'segmented', fraction: 0.45, detail: '分段扫描与边界评估' });
        setTimeout(() => {
          try {
            const bundle = runAnalysis({ bytes, digest, params });
            const elapsedMs = Math.round(performance.now() - started);
            post({ type: 'progress', jobId, stage: 'finalize', fraction: 0.95, detail: '整理候选与统计' });
            post({ type: 'done', jobId, bundle, elapsedMs });
          } catch (err) {
            post({ type: 'error', jobId, message: err instanceof Error ? err.message : String(err) });
          }
        }, 0);
      } catch (err) {
        post({ type: 'error', jobId, message: err instanceof Error ? err.message : String(err) });
      }
    }, 0);
  } catch (err) {
    post({ type: 'error', jobId, message: err instanceof Error ? err.message : String(err) });
  }
};

export {};
