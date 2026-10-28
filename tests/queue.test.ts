import { test } from "node:test";
import assert from "node:assert/strict";
import { SerialQueue } from "../src/queue.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("tasks run strictly in submission order even when earlier ones are slower", async () => {
  const q = new SerialQueue();
  const log: string[] = [];
  const a = q.run(async () => {
    log.push("a:start");
    await sleep(30);
    log.push("a:end");
  });
  const b = q.run(async () => {
    log.push("b:start");
    await sleep(1);
    log.push("b:end");
  });
  await Promise.all([a, b]);
  assert.deepEqual(log, ["a:start", "a:end", "b:start", "b:end"]);
});

test("a failing task rejects itself and does not stall the queue", async () => {
  const q = new SerialQueue();
  const failing = q.run(async () => {
    throw new Error("boom");
  });
  const next = q.run(async () => "ok");
  await assert.rejects(failing, /boom/);
  assert.equal(await next, "ok");
});

test("read-await-write without the queue loses an update; with it, none", async () => {
  // Two 'messages' each read a counter, await (the LLM call), then write counter+1.
  const bump = async (state: { n: number }) => {
    const read = state.n;
    await sleep(5);
    state.n = read + 1;
  };

  const racy = { n: 0 };
  await Promise.all([bump(racy), bump(racy)]);
  assert.equal(racy.n, 1, "demonstrates the race the queue exists to prevent");

  const safe = { n: 0 };
  const q = new SerialQueue();
  await Promise.all([q.run(() => bump(safe)), q.run(() => bump(safe))]);
  assert.equal(safe.n, 2);
});
