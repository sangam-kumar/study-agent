# Phase 1: Project Scaffolding & Configuration — Implementation Guide

> **Phase Goal:** Initialize the repository structure, configure Cloudflare Wrangler bindings (Durable Objects with SQLite, Workflows, Workers AI), set up TypeScript, and establish entrypoint stubs that compile cleanly with zero errors.

---

## 1. Prerequisites & Logistics Check
* **Node.js:** v24.11.0 (verified)
* **npm:** 11.6.1 (verified)
* **Wrangler:** v4.147.0 (verified)
* **Working Directory:** `c:\study\study-agent`

---

## 2. Sub-Steps Breakdown

| Step | Action | Output / Target File | Validation Criteria |
|---|---|---|---|
| **1.1** | Create `package.json` & install dependencies | `package.json`, `node_modules/` | `npm install` completes cleanly with 0 errors |
| **1.2** | Configure TypeScript compiler options | `tsconfig.json` | Modern ESNext + Cloudflare Workers types resolution |
| **1.3** | Configure Wrangler settings & bindings | `wrangler.jsonc` | Declares `STUDY_AGENT` (DO with SQLite), `MEDIA_INGESTION_WORKFLOW`, `AI` |
| **1.4** | Create directory structure & stub source files | `src/index.ts`, `src/agent.ts`, `src/workflows/media-ingestion.ts`, etc. | All binding classes and exports match `wrangler.jsonc` |
| **1.5** | Generate types & verify typecheck | `worker-configuration.d.ts` | `npx wrangler types` and `npm run typecheck` exit with code 0 |

---

## 3. Detailed Execution Plan

### Step 1.1: `package.json`
- **Dependencies:**
  - `agents-sdk`: `^0.0.95` (or latest available)
  - `typescript`: `^5.7.0`
  - `@cloudflare/workers-types`: `^4.20250224.0` (or matching latest wrangler)
- **Scripts:**
  - `"dev"`: `"wrangler dev"`
  - `"deploy"`: `"wrangler deploy"`
  - `"typecheck"`: `"tsc --noEmit"`
  - `"cf-typegen"`: `"wrangler types"`

### Step 1.2: `tsconfig.json`
- Target: `ES2022`
- Module: `ESNext`
- ModuleResolution: `Bundler`
- Types: `["@cloudflare/workers-types/2023-07-01"]`

### Step 1.3: `wrangler.jsonc`
- `name`: `"study-agent"`
- `main`: `"src/index.ts"`
- `compatibility_date`: `"2025-02-24"`
- `compatibility_flags`: `["nodejs_compat"]`
- `durable_objects`: `bindings`: `[{ "name": "STUDY_AGENT", "class_name": "StudyAgent" }]`
- `migrations`: `[{ "tag": "v1", "new_sqlite_classes": ["StudyAgent"] }]`
- `workflows`: `[{ "name": "media-ingestion", "binding": "MEDIA_INGESTION_WORKFLOW", "class_name": "MediaIngestionWorkflow" }]`
- `ai`: `{ "binding": "AI" }`

### Step 1.4: Source Directory Skeleton
- `src/index.ts`: Worker entrypoint exporting `fetch` handler.
- `src/agent.ts`: `StudyAgent` Durable Object class.
- `src/workflows/media-ingestion.ts`: `MediaIngestionWorkflow` Workflow class.
- `src/ai/provider.ts`: LLM provider interface stub.
- `src/telegram/bot.ts`: Telegram bot client stub.
- `src/github/client.ts`: GitHub client stub.

### Step 1.5: Verification
- Execute `npx wrangler types` to generate `worker-configuration.d.ts`.
- Execute `npm run typecheck` to confirm end-to-end type safety.
