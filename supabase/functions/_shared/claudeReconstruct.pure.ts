/**
 * Pure, runtime-agnostic request/response shaping for the Claude reconstruction
 * adapter (`claudeReconstruct.ts`).
 *
 * No Deno/Node globals are touched at module load, so this is importable by both
 * the Deno edge adapter AND a vitest spec — letting CI lock the request shape
 * (claude-opus-4-8 surface: native vision/PDF, strict tool output, prompt
 * caching, adaptive thinking/effort, no `temperature`).
 *
 * Self-contained on purpose (zero imports).
 */

export type Role = 'system' | 'user' | 'assistant';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface OAMessage {
  role: Role;
  content: any;
}

import type { AnthropicCredential } from './anthropicRoute.pure.ts';

export interface OATool {
  type: 'function';
  function: { name: string; description?: string; parameters: any };
}

export interface ClaudeReconstructArgs {
  /**
   * Resolved by `anthropicCredential.ts`. Not a raw key string: a deployment
   * may reach Anthropic on a short-lived federated token, and on a workspace
   * of its own.
   */
  credential: AnthropicCredential;
  model?: string;
  messages: OAMessage[];
  tools?: OATool[];
  tool_choice?: 'auto' | 'required' | { type: 'function'; function: { name: string } };
  max_tokens?: number;
  /** Native PDF/document inputs appended to the final user turn. */
  documents?: Array<{ base64: string; mediaType?: string; title?: string }>;
  /** Thinking depth for the agentic (non-forced-tool) path. */
  effort?: Effort;
  /** Enable adaptive thinking. Auto-disabled when a tool is forced (API rule). */
  thinking?: boolean;
  stream?: boolean;
  timeoutMs?: number;
}

export interface ClaudeReconstructResult {
  ok: boolean;
  status: number;
  data?: any;
  errorText?: string;
}

const IMAGE_DATA_URL = /^data:(image\/(?:png|jpe?g|webp|gif));base64,(.+)$/i;

export function imagePartFromDataUrl(dataUrl: string): any | null {
  const m = IMAGE_DATA_URL.exec(String(dataUrl || ''));
  if (!m) return null;
  return { type: 'image', source: { type: 'base64', media_type: m[1].toLowerCase(), data: m[2] } };
}

/** OpenAI content (string | parts[]) → Anthropic content (string | blocks[]). */
export function convertContent(content: any): any {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  const blocks: any[] = [];
  for (const p of content) {
    if (p?.type === 'text') {
      blocks.push({ type: 'text', text: String(p.text ?? '') });
    } else if (p?.type === 'image_url') {
      const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
      const img = imagePartFromDataUrl(String(url || ''));
      if (img) blocks.push(img);
    } else if (p?.type === 'image' && p.source) {
      blocks.push(p);
    } else if (p?.type === 'document' && p.source) {
      blocks.push(p);
    }
  }
  return blocks.length ? blocks : '';
}

/** Append native PDF/document blocks to the final user turn (mutates `turns`). */
export function appendDocuments(turns: any[], documents?: ClaudeReconstructArgs['documents']): void {
  if (!documents?.length) return;
  const docBlocks = documents.map((d) => ({
    type: 'document',
    source: { type: 'base64', media_type: d.mediaType || 'application/pdf', data: d.base64 },
    ...(d.title ? { title: d.title } : {}),
  }));
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'user') {
      const c = turns[i].content;
      turns[i].content = Array.isArray(c) ? [...c, ...docBlocks] : [{ type: 'text', text: String(c ?? '') }, ...docBlocks];
      return;
    }
  }
  turns.push({ role: 'user', content: docBlocks });
}

/** Map OpenAI tool_choice → Anthropic, and report whether a tool is *forced*. */
export function mapToolChoice(tc: ClaudeReconstructArgs['tool_choice']): { value: any; forced: boolean } {
  if (tc === 'required') return { value: { type: 'any' }, forced: true };
  if (tc && typeof tc === 'object' && tc.type === 'function') {
    return { value: { type: 'tool', name: tc.function.name }, forced: true };
  }
  if (tc === 'auto') return { value: { type: 'auto' }, forced: false };
  return { value: undefined, forced: false };
}

/**
 * Reasoning config. The Messages API rejects forcing a specific tool together
 * with extended/adaptive thinking, so when a tool is forced we omit `thinking`.
 */
export function buildReasoning(args: ClaudeReconstructArgs, toolForced: boolean): Record<string, any> {
  const out: Record<string, any> = {};
  if (toolForced) {
    if (args.thinking) console.warn('[claudeReconstruct] thinking disabled: cannot force a tool and think simultaneously');
    return out;
  }
  if (args.thinking) out.thinking = { type: 'adaptive' };
  if (args.effort) out.output_config = { effort: args.effort };
  return out;
}

/** Reshape an Anthropic message (content blocks) → OpenAI { choices, usage, model }. */
export function toOpenAIShape(data: any): any {
  const blocks: any[] = data?.content || [];
  const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
  const toolUses = blocks.filter((b) => b?.type === 'tool_use');
  const tool_calls = toolUses.map((t: any) => ({
    id: t.id,
    type: 'function',
    function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) },
  }));
  return {
    choices: [{
      message: { role: 'assistant', content: text || null, tool_calls: tool_calls.length ? tool_calls : undefined },
      finish_reason: data?.stop_reason || 'stop',
    }],
    usage: data?.usage,
    model: data?.model,
  };
}

/**
 * Assemble the full Anthropic Messages request body (no fetch). Marks the first
 * system block cacheable, converts multimodal content, appends documents, and
 * sends tools with `strict: true`. Never emits `temperature` (400 on 4.8).
 */
export function buildAnthropicRequestBody(
  args: ClaudeReconstructArgs,
  defaultModel: string,
): { body: any; forced: boolean } {
  const systemText: string[] = [];
  const turns: any[] = [];
  for (const m of args.messages) {
    if (m.role === 'system') {
      const t = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n')
          : String(m.content ?? '');
      if (t.trim()) systemText.push(t);
      continue;
    }
    turns.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: convertContent(m.content) });
  }
  appendDocuments(turns, args.documents);

  const systemBlocks = systemText.map((text, i) => (
    i === 0 ? { type: 'text', text, cache_control: { type: 'ephemeral' } } : { type: 'text', text }
  ));

  const { value: toolChoice, forced } = mapToolChoice(args.tool_choice);

  const body: any = {
    model: args.model || defaultModel,
    max_tokens: args.max_tokens ?? 8192,
    system: systemBlocks,
    messages: turns,
    ...buildReasoning(args, forced),
  };
  if (args.tools?.length) {
    body.tools = args.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description || '',
      input_schema: t.function.parameters,
      strict: true,
    }));
    if (toolChoice) body.tool_choice = toolChoice;
  }
  return { body, forced };
}

/** Opus 4.7+/Fable reject `temperature`/`top_p`/`top_k` (400); older models accept them. */
export function anthropicRejectsSampling(model: string): boolean {
  return /opus-4-[789]\b|fable/.test(String(model || ''));
}
