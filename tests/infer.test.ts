import { test } from "node:test";
import assert from "node:assert/strict";
import { InferError, ValidationError, infer } from "../src/infer.ts";
import type { InferBackend } from "../src/infer.ts";

const quiet = () => {};
const schema = { type: "object" };
const positive = (raw: unknown) => {
  const n = (raw as { n?: unknown }).n;
  if (typeof n !== "number" || n <= 0) throw new ValidationError("n must be positive");
  return n;
};

function backend(name: string, answers: (user: string, call: number) => unknown): InferBackend & { calls: string[] } {
  const calls: string[] = [];
  return {
    name,
    calls,
    async json(req) {
      calls.push(req.user);
      const a = answers(req.user, calls.length);
      if (a instanceof Error) throw a;
      return a;
    },
  };
}

test("a failing backend (429) falls through to the next one", async () => {
  const a = backend("gemini", () => new Error("Gemini HTTP 429: quota"));
  const b = backend("workers-ai", () => ({ n: 3 }));
  assert.equal(await infer([a, b], { task: "t", system: "s", user: "u", schema, validate: positive }, quiet), 3);
  assert.equal(a.calls.length, 1, "transport errors are not retried on the same backend");
  assert.equal(b.calls.length, 1);
});

test("an invalid answer is retried once on the same backend with the reason appended", async () => {
  const a = backend("gemini", (_u, call) => (call === 1 ? { n: -1 } : { n: 7 }));
  const b = backend("workers-ai", () => ({ n: 1 }));
  assert.equal(await infer([a, b], { task: "t", system: "s", user: "question", schema, validate: positive }, quiet), 7);
  assert.equal(a.calls.length, 2);
  assert.match(a.calls[1], /question[\s\S]*rejected: n must be positive/);
  assert.equal(b.calls.length, 0, "fallback is not used when the retry succeeds");
});

test("two bad answers move on to the next backend", async () => {
  const a = backend("gemini", () => ({ n: 0 }));
  const b = backend("workers-ai", () => ({ n: 5 }));
  assert.equal(await infer([a, b], { task: "t", system: "s", user: "u", schema, validate: positive }, quiet), 5);
  assert.equal(a.calls.length, 2);
});

test("InferError lists every attempt when nothing works", async () => {
  const a = backend("gemini", () => new Error("down"));
  const b = backend("workers-ai", () => ({ n: -1 }));
  await assert.rejects(
    () => infer([a, b], { task: "classify", system: "s", user: "u", schema, validate: positive }, quiet),
    (e: unknown) => {
      assert.ok(e instanceof InferError);
      assert.deepEqual(e.attempts.map((x) => [x.backend, x.kind]), [["gemini", "transport"], ["workers-ai", "validation"], ["workers-ai", "validation"]]);
      return true;
    },
  );
});

test("no backends at all is an InferError, not a crash", async () => {
  await assert.rejects(() => infer([], { task: "t", system: "s", user: "u", schema, validate: positive }, quiet), InferError);
});
