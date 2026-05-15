export class TaskQueue {
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly maxConcurrency: number = 1) {}

  async enqueue(taskId: string, work: () => Promise<void>): Promise<boolean> {
    if (this.isFull || this.running.has(taskId)) {
      return false;
    }

    const runPromise = Promise.resolve()
      .then(work)
      .finally(() => {
        this.running.delete(taskId);
      });

    this.running.set(taskId, runPromise);
    return true;
  }

  get activeCount(): number {
    return this.running.size;
  }

  get isFull(): boolean {
    return this.activeCount >= this.maxConcurrency;
  }

  async drain(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.allSettled(this.running.values());
    }
  }
}
