interface QueueItem {
  id: string;
  execute: () => Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
}

const postQueue: QueueItem[] = [];
let isProcessing = false;

async function processQueue() {
  if (isProcessing || postQueue.length === 0) return;
  isProcessing = true;

  const item = postQueue.shift();
  if (item) {
    try {
      await item.execute();
      item.resolve();
    } catch (err) {
      item.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  isProcessing = false;
  // Process next if any
  if (postQueue.length > 0) {
    processQueue();
  }
}

export function enqueuePost(execute: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    postQueue.push({ id: Math.random().toString(36), execute, resolve, reject });
    processQueue();
  });
}