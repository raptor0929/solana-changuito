import type Anthropic from '@anthropic-ai/sdk';

import type { HopCallbacks, HopRequest, HopResult, Provider } from './types';

/**
 * The shopping model when `OPENAI_API_KEY` is set.
 *
 * The loop still speaks Anthropic's message shape — tool uses, tool results,
 * a photo as a base64 block — because that is what the turn store and the
 * render tools already are. This file is the translation, in both directions,
 * and nothing else. A photo rides as a data URL so the same JPEG the shopper
 * attached is what the model sees.
 */

const MODEL = process.env.OPENAI_MODEL?.trim() || 'gpt-4.1';

/**
 * Sent only when set, because no one value works for every model. The Luna
 * models take function tools on Chat Completions only at `none`; gpt-5-nano
 * rejects `none` and bottoms out at `minimal`; gpt-4.1 and gpt-4o-mini are not
 * reasoning models and reject the parameter outright. Unset sends nothing,
 * which is what this file did before it existed.
 */
const REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT?.trim() || '';

type OaiContent =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

type OaiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | OaiContent[] }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

type OaiTool = {
  type: 'function';
  function: { name: string; description?: string; parameters: Record<string, unknown> };
};

interface ToolAcc {
  id: string;
  name: string;
  args: string;
}

export function openAiTools(tools: Anthropic.ToolUnion[]): OaiTool[] {
  return tools.map((tool) => {
    const t = tool as Anthropic.Tool;
    const schema = { ...(t.input_schema as Record<string, unknown>) };
    delete schema.cache_control;
    return {
      type: 'function',
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: schema,
      },
    };
  });
}

function textOf(block: Anthropic.ContentBlockParam): string {
  return block.type === 'text' ? block.text : '';
}

function imageUrl(block: Anthropic.ContentBlockParam): string | null {
  if (block.type !== 'image') return null;
  const source = block.source;
  if (source.type !== 'base64') return null;
  return `data:${source.media_type};base64,${source.data}`;
}

/** Anthropic turns, as the chat-completions messages OpenAI accepts. */
export function openAiMessages(req: Pick<HopRequest, 'system' | 'messages'>): OaiMessage[] {
  const out: OaiMessage[] = [];
  const system = req.system.map((b) => b.text).filter(Boolean).join('\n\n').trim();
  if (system) out.push({ role: 'system', content: system });

  for (const message of req.messages) {
    if (typeof message.content === 'string') {
      out.push({ role: message.role, content: message.content } as OaiMessage);
      continue;
    }
    const blocks = message.content;
    if (message.role === 'assistant') {
      const text = blocks.map(textOf).filter(Boolean).join('');
      const calls = blocks.flatMap((block) => {
        if (block.type !== 'tool_use') return [];
        return [
          {
            id: block.id,
            type: 'function' as const,
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          },
        ];
      });
      out.push({
        role: 'assistant',
        content: text || null,
        ...(calls.length ? { tool_calls: calls } : {}),
      });
      continue;
    }

    const tools = blocks.filter((b) => b.type === 'tool_result');
    if (tools.length && tools.length === blocks.length) {
      for (const block of tools) {
        if (block.type !== 'tool_result') continue;
        const body = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
        out.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: block.is_error ? `Error: ${body}` : body,
        });
      }
      continue;
    }

    const content: OaiContent[] = [];
    for (const block of blocks) {
      const url = imageUrl(block);
      if (url) content.push({ type: 'image_url', image_url: { url } });
      else if (block.type === 'text' && block.text) content.push({ type: 'text', text: block.text });
    }
    if (content.length) out.push({ role: 'user', content });
  }
  return out;
}

export function openaiProvider(): Provider {
  const key = process.env.OPENAI_API_KEY?.trim() ?? '';

  return {
    kind: 'openai',
    label: MODEL,

    async hop(req: HopRequest, cb: HopCallbacks): Promise<HopResult> {
      if (!key) throw new Error('Falta OPENAI_API_KEY. Cargala en el proyecto y volvé a publicar.');

      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          stream: true,
          max_completion_tokens: 4096,
          ...(REASONING_EFFORT ? { reasoning_effort: REASONING_EFFORT } : {}),
          messages: openAiMessages(req),
          tools: openAiTools(req.tools),
        }),
        signal: AbortSignal.timeout(Math.max(1_000, req.budgetMs)),
      });

      if (!res.ok || !res.body) {
        // The body can echo the request. Never log it: it carries the photo
        // and, on a 401, nothing we want next to the key in a build log.
        // Its error's type, code and param are identifiers, not content, and
        // without them a 400 says that the request was wrong but not where.
        const err = ((await res.json().catch(() => null)) as { error?: Record<string, unknown> } | null)?.error;
        console.error('[openai]', res.status, MODEL, { type: err?.type, code: err?.code, param: err?.param });
        throw new Error(
          res.status === 401
            ? 'OpenAI rechazó la clave. Revisá OPENAI_API_KEY en Vercel.'
            : `OpenAI respondió ${res.status}.`,
        );
      }

      const calls = new Map<number, ToolAcc>();
      let finish: string | null = null;
      let text = '';
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const take = (raw: string) => {
        let json: {
          choices?: {
            finish_reason?: string | null;
            delta?: {
              content?: string | null;
              tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
            };
          }[];
        };
        try {
          json = JSON.parse(raw) as typeof json;
        } catch {
          return;
        }
        const choice = json.choices?.[0];
        if (!choice) return;
        if (choice.finish_reason) finish = choice.finish_reason;
        const delta = choice.delta;
        if (delta?.content) {
          text += delta.content;
          cb.onText(delta.content);
        }
        for (const call of delta?.tool_calls ?? []) {
          const cur = calls.get(call.index) ?? { id: '', name: '', args: '' };
          if (call.id) cur.id = call.id;
          if (call.function?.name) cur.name += call.function.name;
          if (call.function?.arguments) cur.args += call.function.arguments;
          calls.set(call.index, cur);
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') continue;
          take(data);
        }
      }

      const content: Anthropic.ContentBlockParam[] = [];
      if (text) content.push({ type: 'text', text });
      let broken = false;
      const ordered = [...calls.entries()].sort((a, b) => a[0] - b[0]);
      for (const [index, call] of ordered) {
        let input: unknown = {};
        if (call.args) {
          try {
            input = JSON.parse(call.args) as unknown;
          } catch {
            broken = true;
          }
        }
        content.push({
          type: 'tool_use',
          id: call.id || `call_${index}`,
          name: call.name,
          input: input as Anthropic.ToolUseBlockParam['input'],
        });
      }

      if (broken || finish === 'length') {
        return { content, stopReason: 'max_tokens' };
      }
      if (finish === 'content_filter') {
        return { content, stopReason: 'refusal' };
      }
      if (ordered.length) return { content, stopReason: 'tool_use' };
      return { content, stopReason: 'end_turn' };
    },
  };
}
