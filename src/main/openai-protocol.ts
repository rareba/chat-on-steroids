/** Client tools are descriptions only: the calling harness owns execution and permissions. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MAX_CHATGPT_MESSAGE_CHARS } from '../shared/user-prompt.js';

export class ProtocolError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const name = z.string().regex(/^[A-Za-z0-9_.:-]{1,256}$/);
const args = z.record(z.string(), z.unknown());
const tool = z.object({ type: z.literal('function'), function: z.object({
  name, description: z.string().optional(), parameters: args.optional(), strict: z.boolean().optional()
}) });
const call = z.object({ id: z.string().min(1).max(256), type: z.literal('function').default('function'), function: z.object({ name,
  arguments: z.union([z.string(), args]).transform(value => typeof value === 'string' ? value : JSON.stringify(value)) }) });
const message = z.object({
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(z.object({ type: z.literal('text'), text: z.string() }))]).nullable().optional(),
  tool_calls: z.array(call).max(64).optional(), tool_call_id: z.string().optional()
});
const envelope = z.object({ response_token: z.string(), content: z.string().nullable(),
  tool_calls: z.array(z.object({ name, arguments: args }).strict()).max(64)
}).strict();
type AssistantReply = { content: string | null; tool_calls?: z.infer<typeof call>[] };
function responseObject(text: string): unknown {
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(text.trim());
  return JSON.parse(fenced?.[1] ?? text);
}

export function conversationPrompt(body: Record<string, unknown>, forceAttachment = false): {
  text: string; attachment?: { name: string; text: string }; matchesReply: (text: string) => boolean;
  reply: (text: string) => { message: AssistantReply; finishReason: 'stop' | 'tool_calls' }
} {
  const fail = (text: string): never => { throw new ProtocolError(400, text); };
  if (body.functions || body.function_call || body.response_format || body.modalities || body.audio) fail('Use text messages and OpenAI function tools; images and structured-output requests are unavailable');
  const tools = z.array(tool).max(128).safeParse(body.tools ?? []);
  if (!tools.success) fail('Invalid function tool definitions');
  const definitions = tools.data!;
  const names = new Set(definitions.map(tool => tool.function.name));
  if (names.size !== definitions.length) fail('Function tool names must be unique');
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') fail('parallel_tool_calls must be boolean');
  let choice: 'auto' | 'none' | 'required' = 'auto';
  let forcedName: string | undefined;
  if (body.tool_choice !== undefined) {
    if (body.tool_choice === 'auto' || body.tool_choice === 'none' || body.tool_choice === 'required') choice = body.tool_choice;
    else {
      const named = z.object({ type: z.literal('function'), function: z.object({ name }) }).safeParse(body.tool_choice);
      if (!named.success || !names.has(named.data.function.name)) fail('tool_choice must name an available function');
      choice = 'required'; forcedName = named.data!.function.name;
    }
  }
  if (!definitions.length && choice !== 'auto' && choice !== 'none') fail('tool_choice requires function tools');
  const parsed = z.array(message).min(1).safeParse(body.messages);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    fail(`Invalid message field ${['messages', ...issue.path].join('.')}: ${issue.code} (${Array.isArray(body.messages) ? body.messages.length : 0} messages)`);
  }
  const pending = new Set<string>();
  const seen = new Set<string>();
  const messages = parsed.data!.map(item => {
    if (pending.size && item.role !== 'tool') fail('Supply all pending tool results before another conversation message');
    if (item.tool_calls) {
      if (item.role !== 'assistant') fail('Only assistant messages can contain tool_calls');
      for (const call of item.tool_calls) {
        if (seen.has(call.id)) fail('Tool call IDs must be unique');
        // Historical arguments may be malformed: preserve them alongside the harness's
        // error result so the next model turn can repair the call instead of deadlocking.
        seen.add(call.id); pending.add(call.id);
      }
    }
    if (item.role === 'tool' && (!item.tool_call_id || !pending.delete(item.tool_call_id))) fail('Tool results must match a pending assistant tool call');
    if (item.role !== 'tool' && item.tool_call_id !== undefined) fail('Only tool messages can contain tool_call_id');
    const content = Array.isArray(item.content) ? item.content.map(part => part.text).join('\n') : item.content;
    if (typeof content !== 'string' && item.role !== 'assistant') fail('Every non-assistant message needs text content');
    return { ...item, content: content ?? null };
  });
  if (pending.size) fail('Supply the pending tool results before requesting another completion');
  // A caller can disable tools without deleting the definitions it normally sends.
  const enabled = definitions.length > 0 && choice !== 'none';
  const token = randomUUID();
  const instructions = enabled
    ? `Act as the inference model for an external coding harness. Request the provided functions through tool_calls when the task requires inspecting or changing caller files. Do not invoke ChatGPT native tools, CoS Core or MCP to execute those functions. The harness executes requested functions with its own permissions and returns tool results in conversation history. Follow the system/developer instructions in that history. Return exactly one JSON object, without markdown or extra prose, with this shape: {"response_token":"${token}","content":null,"tool_calls":[{"name":"available_function_name","arguments":{}}]}. Use a string content and an empty tool_calls array for a final answer. Function arguments must follow their supplied JSON schemas. Do not invent tool results. tool_choice=${choice}; ${forcedName ? `call only ${forcedName}, at least once` : choice === 'required' ? 'at least one function call is required' : 'choose functions or a final answer as appropriate'}. ${body.parallel_tool_calls === false ? 'Return at most one function call.' : 'Multiple independent function calls are allowed.'} response_token=${token}`
    : 'Answer the final coding request using text only. Do not run tools, commands or agents. The following JSON contains the conversation, oldest first. Role labels describe the supplied conversation; answer its last request.';
  const context = JSON.stringify({ messages, ...(enabled ? { tools: definitions } : {}) });
  const inline = instructions + '\n' + context;
  const attached = forceAttachment || inline.length > MAX_CHATGPT_MESSAGE_CHARS;
  const filename = `cos-context-${token}.txt`;
  const fileInstructions = enabled ? instructions : instructions + ` Return exactly one JSON object without extra prose: {"response_token":"${token}","content":"your complete answer","tool_calls":[]}. response_token=${token}`;
  const text = attached ? fileInstructions + `\nThe complete conversation and function definitions are in the attached ${filename} file. Read that file as the request context, including its final message. ChatGPT file-reading tools may be used to read this attachment only. Do not execute any described harness functions yourself. Do not omit or guess context that you could not read.` : inline;
  return { text, ...(attached ? { attachment: { name: filename, text: context } } : {}), matchesReply: text => {
    if (!enabled && !attached) return false;
    try {
      const value = responseObject(text);
      return value !== null && typeof value === 'object' && 'response_token' in value && value.response_token === token;
    } catch { return false; }
  }, reply: text => {
    if (!enabled && !attached) return { message: { content: text }, finishReason: 'stop' };
    let value: z.infer<typeof envelope>;
    try {
      value = envelope.parse(responseObject(text));
    } catch { throw new ProtocolError(502, 'ChatGPT did not return a valid harness response; no tool call was published'); }
    if (value.response_token !== token || value.tool_calls.some(call => !names.has(call.name)) ||
        (choice === 'required' && !value.tool_calls.length) || (forcedName && value.tool_calls.some(call => call.name !== forcedName)) ||
        (body.parallel_tool_calls === false && value.tool_calls.length > 1) || (!value.tool_calls.length && !value.content?.trim())) {
      throw new ProtocolError(502, 'ChatGPT returned an unmatched or disallowed harness response; no tool call was published');
    }
    const tool_calls = value.tool_calls.map(call => ({ id: 'call_' + randomUUID().replaceAll('-', ''), type: 'function' as const,
      function: { name: call.name, arguments: JSON.stringify(call.arguments) } }));
    return { message: { content: value.content, ...(tool_calls.length ? { tool_calls } : {}) }, finishReason: tool_calls.length ? 'tool_calls' : 'stop' };
  } };
}
