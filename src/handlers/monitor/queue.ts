/**
 * Serializes **review "Post"** work.
 */
import logger from "../../logger";

const log = logger.child({ module: "monitor/queue" });

interface QueueItem {
  id: string;
  execute: () => Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
}

const postQueue: QueueItem[] = [];
let isProcessing = false;

const POST_JOB_TIMEOUT_MS = 90_000;

function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);

    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function processQueue() {
  if (isProcessing || postQueue.length === 0) return;
  isProcessing = true;

  const item = postQueue.shift();
  if (!item) {
    isProcessing = false;
    return;
  }

  try {
    log.debug({ queueItemId: item.id }, "Starting post queue job");
    await withTimeout(item.execute(), POST_JOB_TIMEOUT_MS, "post job");
    log.debug({ queueItemId: item.id }, "Finished post queue job");
    item.resolve();
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error({ err: error.message, queueItemId: item.id }, "Post queue job failed");
    item.reject(error);
  } finally {
    isProcessing = false;
    // Process next if any
    if (postQueue.length > 0) {
      processQueue();
    }
  }
}

export function enqueuePost(execute: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    postQueue.push({ id: Math.random().toString(36), execute, resolve, reject });
    processQueue();
  });
}