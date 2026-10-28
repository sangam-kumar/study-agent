/**
 * Runs async tasks one at a time, in submission order.
 *
 * A Durable Object serves RPC calls concurrently whenever one awaits (an LLM call, a
 * Telegram fetch). Without this, two quick messages can read the same state and the
 * second write clobbers the first. A failing task rejects its own promise only; the
 * queue keeps going.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => task());
    this.tail = result.catch(() => undefined);
    return result;
  }
}
