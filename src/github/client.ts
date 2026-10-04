export class GitHubClient {
  constructor(private token: string, private repo: string) {}

  async getFileContent(path: string, ref = "main"): Promise<{ content: string; sha: string }> {
    const url = `https://api.github.com/repos/${this.repo}/contents/${path}?ref=${ref}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "study-agent",
      },
    });

    if (!res.ok) {
      throw new Error(`GitHub getFileContent failed [${res.status}]: ${await res.text()}`);
    }

    const data = (await res.json()) as { content: string; sha: string; encoding: string };
    const decoded = atob(data.content.replace(/\n/g, ""));
    return { content: decoded, sha: data.sha };
  }

  async commitFile(path: string, content: string, message: string, sha?: string, branch = "main"): Promise<void> {
    const url = `https://api.github.com/repos/${this.repo}/contents/${path}`;
    const body: Record<string, unknown> = {
      message,
      content: btoa(content),
      branch,
    };
    if (sha) {
      body.sha = sha;
    }

    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "study-agent",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`GitHub commitFile failed [${res.status}]: ${await res.text()}`);
    }
  }
}
