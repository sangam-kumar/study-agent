# Phase 4: AI Pipeline (Gemini Primary + Cloudflare Workers AI Fallback) — Implementation Guide

> **Phase Goal:** Build a pluggable, dual-provider AI inference engine. Gemini 2.5 Flash acts as the primary LLM for structured JSON schema extraction and native multimodal audio parsing. Cloudflare Workers AI (`@cf/meta/llama-3.3-70b-instruct` and `@cf/openai/whisper`) acts as the secondary fallback. Implement in-memory zero-storage audio streaming for voice memos.

---

## 1. Overview & Architecture

```
                    ┌────────────────────────────────────────────────────────┐
                    │               Inbound Telegram Message                 │
                    │               (Text or Voice Memo OGG)                 │
                    └──────────────────────────┬─────────────────────────────┘
                                               │
                                               ▼
                              ┌─────────────────────────────────┐
                              │     Zero-Storage Stream /       │
                              │     In-Memory Buffer Extraction │
                              └────────────────┬────────────────┘
                                               │
                                               ▼
                              ┌─────────────────────────────────┐
                              │      Pluggable LLMProvider      │
                              │      (src/ai/provider.ts)       │
                              └────────┬───────────────┬────────┘
                                       │               │
                     LLM_PROVIDER=gemini               LLM_PROVIDER=cloudflare (or fallback)
                                       │               │
                                       ▼               ▼
                        ┌────────────────────┐   ┌───────────────────────┐
                        │   Google Gemini    │   │ Cloudflare Workers AI │
                        │  Gemini 2.5 Flash  │   │  Llama 3.3 + Whisper  │
                        └─────────┬──────────┘   └───────────┬───────────┘
                                  └────────────┬─────────────┘
                                               │
                                               ▼
                              ┌─────────────────────────────────┐
                              │     Structured JSON Outputs     │
                              │  • Intent Classification        │
                              │  • Workout Log Extraction       │
                              │  • Audio Transcription & Note   │
                              │  • URL Metadata & Summary       │
                              └────────────────┬────────────────┘
                                               │
                                               ▼
                              ┌─────────────────────────────────┐
                              │  Persist in SQLite & Reply TG   │
                              └─────────────────────────────────┘
```

---

## 2. In-Memory Zero-Storage Stream Pattern
Audio notes are **never written to disk, R2, or SQLite**:
1. Inbound Telegram voice memo provides `file_id`.
2. Worker fetches the audio stream via Telegram API into an in-memory `ArrayBuffer`.
3. The buffer is passed directly to Gemini (as base64 inline audio data) or Whisper on Workers AI.
4. Structured transcript and parsed workout/note JSON are returned.
5. The audio buffer is immediately garbage collected.

---

## 3. Sub-Steps Breakdown

| Step | Action | Target Files | Validation Criteria |
|---|---|---|---|
| **4.1** | Define comprehensive LLM interfaces, prompt templates & JSON schemas | `src/ai/provider.ts`, `src/ai/schemas.ts` | Fully typed intent & extraction interfaces |
| **4.2** | Implement Google Gemini Provider (Gemini 2.5 Flash) with structured JSON | `src/ai/gemini.ts` | Direct REST integration with strict JSON response schema |
| **4.3** | Implement Multimodal Audio-to-JSON in Gemini (voice note processing) | `src/ai/gemini.ts` | Accepts `ArrayBuffer` (audio/ogg) and parses workout/note directly |
| **4.4** | Implement Cloudflare Workers AI Provider (Llama 3.3 + Whisper fallback) | `src/ai/workers-ai.ts` | Uses `env.AI` binding for text and audio inference |
| **4.5** | Wire LLM Provider into `StudyAgent` and test with live Telegram inputs | `src/agent.ts` | Real voice memos & text workouts parsed into SQLite and acknowledged |

---

## 4. Current Status: Completed

All sub-steps (4.1 through 4.5) have been implemented and verified with clean typechecks:
- Generic `LLMProvider` interface and schema definitions (`src/ai/schemas.ts`, `src/ai/provider.ts`).
- Gemini 2.5 Flash direct REST integration with structured JSON outputs and chunked base64 audio handling (`src/ai/gemini.ts`).
- Cloudflare Workers AI fallback with `@cf/meta/llama-3.3-70b-instruct` and `@cf/openai/whisper` (`src/ai/workers-ai.ts`).
- In-memory `ArrayBuffer` stream download via Telegram API (`src/telegram/bot.ts`).
- Intent routing and SQLite workout/log persistence inside `StudyAgent` (`src/agent.ts`).
