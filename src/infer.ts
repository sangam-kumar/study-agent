// One door for every model call: infer(task, schema, inputs) -> typed, validated result.
// The provider is configuration, not architecture.
//
//   * A backend that errors (HTTP 429/5xx, network, empty answer) is skipped: the next one is tried.
//   * An answer that fails validation gets ONE retry on the same backend, with the rejection reason
//     appended; if that also fails the next backend is tried.
//   * When nothing works, InferError carries every attempt so the caller can log it and save the
//     user's message to the inbox instead of losing it.

export type JsonSchema = Record<string, unknown>;

export interface InferBackend {
  name: string;
  /** Returns the parsed JSON answer. Throws on transport errors or unparseable output. */
  json(req: { system: string; user: string; schema: JsonSchema }): Promise<unknown>;
}

export interface InferRequest<T> {
  /** Short label for logs: "classify", "extract:reading", ... */
  task: string;
  system: string;
  user: string;
  schema: JsonSchema;
  /** Throws ValidationError (or any Error) when the answer is not acceptable. */
  validate: (raw: unknown) => T;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export interface InferAttempt {
  backend: string;
  kind: "transport" | "validation";
  error: string;
}

export class InferError extends Error {
  readonly attempts: InferAttempt[];
  constructor(task: string, attempts: InferAttempt[]) {
    super(`${task} failed on every backend: ${attempts.map((a) => `${a.backend}(${a.kind}): ${a.error}`).join("; ")}`);
    this.name = "InferError";
    this.attempts = attempts;
  }
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export async function infer<T>(
  backends: InferBackend[],
  req: InferRequest<T>,
  log: (line: string) => void = console.warn,
): Promise<T> {
  const attempts: InferAttempt[] = [];

  for (const backend of backends) {
    let user = req.user;
    for (let tryNo = 0; tryNo < 2; tryNo++) {
      let raw: unknown;
      try {
        raw = await backend.json({ system: req.system, user, schema: req.schema });
      } catch (e) {
        attempts.push({ backend: backend.name, kind: "transport", error: msg(e) });
        log(`infer ${req.task}: ${backend.name} failed, trying next: ${msg(e)}`);
        break; // transport trouble: no point retrying the same backend
      }
      try {
        return req.validate(raw);
      } catch (e) {
        attempts.push({ backend: backend.name, kind: "validation", error: msg(e) });
        log(`infer ${req.task}: ${backend.name} answer rejected: ${msg(e)}`);
        user = `${req.user}\n\nYour previous answer was rejected: ${msg(e)}. Return corrected JSON that follows the schema exactly.`;
      }
    }
  }
  throw new InferError(req.task, attempts);
}
