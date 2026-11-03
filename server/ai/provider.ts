/**
 * AI provider abstraction. Groq is primary (OpenAI-compatible API).
 * Any OpenAI-compatible endpoint (e.g. Gemini's OpenAI endpoint, OpenRouter) can be the fallback
 * by setting AI_FALLBACK_BASE_URL / AI_FALLBACK_API_KEY / AI_FALLBACK_TEXT_MODEL.
 * Keys live only on the server.
 */
import { z } from 'zod';
import { whisperLanguage } from '../../shared/lang.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
}

interface Endpoint {
  name: string;
  baseUrl: string;
  apiKey: string | undefined;
  textModel: string;
  fastModel: string;
  visionModel: string | null;
  sttModel: string | null;
}

const env = process.env;

export const PRIMARY: Endpoint = {
  name: 'groq',
  baseUrl: env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1',
  apiKey: env.GROQ_API_KEY,
  textModel: env.GROQ_TEXT_MODEL ?? 'openai/gpt-oss-120b',
  fastModel: env.GROQ_FAST_MODEL ?? 'openai/gpt-oss-20b',
  visionModel: env.GROQ_VISION_MODEL ?? 'qwen/qwen3.8-27b',
  sttModel: env.GROQ_STT_MODEL ?? 'whisper-large-v3-turbo',
};

export const FALLBACK: Endpoint | null = env.AI_FALLBACK_BASE_URL
  ? {
      name: env.AI_FALLBACK_NAME ?? 'fallback',
      baseUrl: env.AI_FALLBACK_BASE_URL,
      apiKey: env.AI_FALLBACK_API_KEY,
      textModel: env.AI_FALLBACK_TEXT_MODEL ?? 'gemini-2.5-flash',
      fastModel: env.AI_FALLBACK_TEXT_MODEL ?? 'gemini-2.5-flash',
      visionModel: env.AI_FALLBACK_VISION_MODEL ?? env.AI_FALLBACK_TEXT_MODEL ?? null,
      sttModel: null,
    }
  : null;

export class AIUnavailableError extends Error {}

export function aiConfigured() {
  return Boolean(PRIMARY.apiKey || FALLBACK?.apiKey);
}

async function postJSON(ep: Endpoint, path: string, body: unknown, timeoutMs = 20000) {
  if (!ep.apiKey) throw new AIUnavailableError(`${ep.name} key missing`);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${ep.baseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ep.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const txt = await res.text();
      const err = new Error(`${ep.name} ${res.status}: ${txt.slice(0, 300)}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return res.json() as Promise<any>;
  } finally {
    clearTimeout(t);
  }
}

async function withRetry<T>(fn: () => Promise<T>, tries = 2): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      last = e;
      if (e instanceof AIUnavailableError) throw e;
      if (e?.status && e.status < 500 && e.status !== 429) throw e; // don't retry client errors
      await new Promise((r) => setTimeout(r, 400 * 2 ** i));
    }
  }
  throw last;
}

export interface ChatOptions {
  fast?: boolean;
  vision?: boolean;
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
}

export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<{ text: string; provider: string; model: string }> {
  const endpoints = [PRIMARY, FALLBACK].filter(Boolean) as Endpoint[];
  let lastErr: unknown = new AIUnavailableError('No AI provider configured');
  for (const ep of endpoints) {
    if (!ep.apiKey) continue;
    const model = opts.vision ? ep.visionModel : opts.fast ? ep.fastModel : ep.textModel;
    if (!model) continue;
    try {
      const body: any = {
        model,
        messages,
        temperature: opts.temperature ?? 0.2,
        max_completion_tokens: opts.maxTokens ?? 900,
      };
      if (opts.json) body.response_format = { type: 'json_object' };
      if (model.startsWith('openai/gpt-oss')) body.reasoning_effort = 'low';
      const data = await withRetry(() => postJSON(ep, '/chat/completions', body));
      const text = data?.choices?.[0]?.message?.content ?? '';
      return { text, provider: ep.name, model };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** Ask for JSON and validate it with a schema. Throws if invalid after one repair attempt. */
export async function chatJSON<T>(schema: z.ZodType<T>, messages: ChatMessage[], opts: ChatOptions = {}): Promise<{ data: T; provider: string; model: string }> {
  const first = await chat(messages, { ...opts, json: true });
  const tryParse = (t: string) => {
    const m = t.match(/\{[\s\S]*\}/);
    return schema.safeParse(JSON.parse(m ? m[0] : t));
  };
  try {
    const p = tryParse(first.text);
    if (p.success) return { data: p.data, provider: first.provider, model: first.model };
  } catch { /* fallthrough */ }
  const second = await chat([...messages, { role: 'assistant', content: first.text }, { role: 'user', content: 'That was not valid JSON for the schema. Reply with only the corrected JSON object.' }], { ...opts, json: true });
  const p2 = tryParse(second.text);
  if (!p2.success) throw new Error('AI returned invalid structured output');
  return { data: p2.data, provider: second.provider, model: second.model };
}

/** Speech to text with Groq Whisper. */
export async function transcribe(audio: Buffer, mime: string, filename = 'speech.webm', language: unknown = 'en'): Promise<string> {
  const ep = PRIMARY;
  if (!ep.apiKey || !ep.sttModel) throw new AIUnavailableError('Speech-to-text not configured');
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), filename);
  form.append('model', ep.sttModel);
  form.append('language', whisperLanguage(language)); // whitelisted: en, es, pl, fr, de, pt
  form.append('response_format', 'json');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(`${ep.baseUrl}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${ep.apiKey}` }, body: form, signal: ctrl.signal });
    if (!res.ok) throw new Error(`STT ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as any;
    return String(data.text ?? '').trim();
  } finally {
    clearTimeout(t);
  }
}

export async function health() {
  const out: Record<string, { configured: boolean; ok?: boolean; error?: string }> = {};
  for (const ep of [PRIMARY, FALLBACK].filter(Boolean) as Endpoint[]) {
    out[ep.name] = { configured: Boolean(ep.apiKey) };
    if (!ep.apiKey) continue;
    try {
      const res = await fetch(`${ep.baseUrl}/models`, { headers: { Authorization: `Bearer ${ep.apiKey}` } });
      out[ep.name].ok = res.ok;
      if (!res.ok) out[ep.name].error = `HTTP ${res.status}`;
    } catch (e: any) {
      out[ep.name].ok = false;
      out[ep.name].error = e.message;
    }
  }
  return out;
}
