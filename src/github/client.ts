// Minimal GitHub client for mirroring into study-repo.
// Several files land in ONE commit (Git Data API: tree -> commit -> move the branch). If the branch
// moved meanwhile (the repo's own GitHub Actions commit there too), everything is rebuilt on the
// new head and tried again, so nothing written by someone else is ever overwritten.

export interface FileChange {
  path: string;
  content: string;
}

export interface CommitPlan {
  message: string;
  files: FileChange[];
}

/** Reads a file at the commit being built on. null = the file does not exist. */
export type ReadAt = (path: string) => Promise<string | null>;

export type CommitResult = { committed: false } | { committed: true; sha: string; paths: string[] };

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const API = "https://api.github.com";
const MAX_ATTEMPTS = 3;

function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export class GitHubError extends Error {
  readonly status: number;
  constructor(what: string, status: number, body: string) {
    super(`GitHub ${what} failed [${status}]: ${body.slice(0, 200)}`);
    this.name = "GitHubError";
    this.status = status;
  }
}

export class GitHubClient {
  private readonly token: string;
  private readonly repo: string;
  private readonly branch: string;
  private readonly fetchImpl: Fetch;

  constructor(token: string, repo: string, branch = "master", fetchImpl: Fetch = (u, i) => fetch(u, i)) {
    this.token = token;
    this.repo = repo;
    this.branch = branch;
    this.fetchImpl = fetchImpl;
  }

  private async call<T>(what: string, method: string, path: string, body?: unknown, allow404 = false): Promise<T | null> {
    const res = await this.fetchImpl(`${API}/repos/${this.repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "study-agent",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (allow404 && res.status === 404) return null;
    if (!res.ok) throw new GitHubError(what, res.status, await res.text());
    return (await res.json()) as T;
  }

  async readFile(path: string, ref: string): Promise<string | null> {
    const data = await this.call<{ content?: string; encoding?: string }>(
      "read", "GET", `/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${ref}`, undefined, true,
    );
    if (!data) return null;
    return data.encoding === "base64" && typeof data.content === "string" ? decodeBase64Utf8(data.content) : "";
  }

  /**
   * Builds the change on the current head and commits it in one commit. `build` may return null
   * (nothing to do). If the branch moved before we could update it, the change is rebuilt and retried.
   */
  async commit(build: (read: ReadAt) => Promise<CommitPlan | null>): Promise<CommitResult> {
    for (let attempt = 1; ; attempt++) {
      const ref = await this.call<{ object: { sha: string } }>("get branch", "GET", `/git/ref/heads/${this.branch}`);
      const head = ref!.object.sha;
      const plan = await build((path) => this.readFile(path, head));
      if (!plan || plan.files.length === 0) return { committed: false };

      const headCommit = await this.call<{ tree: { sha: string } }>("get commit", "GET", `/git/commits/${head}`);
      const tree = await this.call<{ sha: string }>("create tree", "POST", "/git/trees", {
        base_tree: headCommit!.tree.sha,
        tree: plan.files.map((f) => ({ path: f.path, mode: "100644", type: "blob", content: f.content })),
      });
      const commit = await this.call<{ sha: string }>("create commit", "POST", "/git/commits", {
        message: plan.message,
        tree: tree!.sha,
        parents: [head],
      });
      try {
        await this.call("update branch", "PATCH", `/git/refs/heads/${this.branch}`, { sha: commit!.sha, force: false });
        return { committed: true, sha: commit!.sha, paths: plan.files.map((f) => f.path) };
      } catch (e) {
        // 422 = not a fast-forward: someone else committed in between. Rebuild on the new head.
        if (e instanceof GitHubError && e.status === 422 && attempt < MAX_ATTEMPTS) continue;
        throw e;
      }
    }
  }
}
