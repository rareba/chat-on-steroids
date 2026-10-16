/** Optional loopback text provider. It shares the control API's consent, not its rotating token. */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { actionsAllowed, serveAction } from './control-actions.js';
import { bridgeStatus } from './bridge.js';
import { getConfig } from './config.js';
import { cosBrowserSignedIn } from './cos-browser/sign-in.js';
import { openBrowserSignIn } from './browser.js';
import { readSessionEvents } from './session/read-model.js';
import { listInputs } from './session/input.js';
import { cancelDesktopInput, sendDesktopInput } from './session/start-input.js';
import { redactSecretText } from './redaction.js';
import { logWarn } from './logger.js';
import type { SessionEvent, ReasoningEffort } from '../shared/session.js';
import { isReasoningEffort } from '../shared/session.js';
import { getChatModels, requestChatModels } from './chat-models.js';
import { resolveChatModel } from '../shared/chat-models.js';
import { responseTurnId } from '../shared/chronology.js';
import { conversationPrompt, ProtocolError } from './openai-protocol.js';
import { stageInputAttachment } from './session/input-attachments.js';
import { prepareSessionPrompt } from './session/prompt.js';

async function selectedModel(signal: AbortSignal, requestedModel: string, requestedEffort?: ReasoningEffort) {
  const named = !['chatgpt-default', 'chatgpt-latest'].includes(requestedModel);
  const target = named ? requestedModel : requestedModel === 'chatgpt-latest' ? 'latest' : process.env.COS_OPENAI_MODEL ?? (requestedEffort ? 'latest' : undefined);
  const configuredEffort = requestedEffort ?? process.env.COS_OPENAI_REASONING_EFFORT ?? (named || requestedModel === 'chatgpt-latest' ? 'xhigh' : undefined);
  if (!target && !configuredEffort) return { model: null, reasoningEffort: null };
  if (!target || !isReasoningEffort(configuredEffort)) throw new ApiError(503, 'Configure COS_OPENAI_MODEL and COS_OPENAI_REASONING_EFFORT together');
  let effort: ReasoningEffort = configuredEffort;
  // A requested send may use one native discovery helper when existing pages hold
  // drafts. The existing discovery owner preserves them and never opens an SSO flow.
  if (target === 'latest' || named) requestChatModels(true);
  let catalog = getChatModels();
  while (catalog.state === 'pending') {
    signal.throwIfAborted();
    await new Promise(resolve => setTimeout(resolve, 250));
    catalog = getChatModels();
  }
  if (catalog.state !== 'ready' || catalog.error) throw new ApiError(503, 'The account model catalog could not be verified; refresh it in CoS');
  let choice;
  if (target === 'latest') {
    const versions = catalog.models.flatMap(choice => {
      const version = /^GPT[- ]?(\d+(?:\.\d+)*)/i.exec(choice.label)?.[1] ?? /^gpt-(\d+(?:\.\d+)*)/i.exec(choice.id)?.[1];
      return version ? [{ choice, version: version.split('.').map(Number) }] : [];
    });
    const compare = (a: number[], b: number[]) => {
      for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (b[i] ?? 0) - (a[i] ?? 0);
      return 0;
    };
    versions.sort((a, b) => compare(a.version, b.version));
    const newest = versions[0];
    const choices = newest ? versions.filter(entry => compare(entry.version, newest.version) === 0 && entry.choice.efforts.includes(effort)).map(entry => entry.choice) : [];
    choice = choices.find(choice => choice.id === `gpt-${newest?.version.join('.')}`) ?? (choices.length === 1 ? choices[0] : undefined);
  } else choice = resolveChatModel(catalog.models, target);
  if (requestedEffort === undefined && named && choice?.efforts.length === 1 && choice.efforts[0] === 'pro') effort = 'pro';
  if (!choice || !choice.efforts.includes(effort)) throw new ApiError(requestedEffort === undefined ? 503 : 400, 'The requested model and reasoning effort are unavailable; no fallback was used');
  return { model: choice.id, reasoningEffort: effort };
}

let server: http.Server | null = null;
let directory = '';
let active: AbortController | null = null;
const requests = new Set<Promise<void>>();
let lastLoginAt = 0;

class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function promptFor(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'Expected a JSON object');
  const body = value as Record<string, unknown>;
  if (body.reasoning_effort !== undefined && !isReasoningEffort(body.reasoning_effort)) throw new ApiError(400, 'Use a reasoning_effort from the model catalog');
  if (typeof body.model !== 'string' || (!['chatgpt-default','chatgpt-latest'].includes(body.model) && !resolveChatModel(getChatModels().models, body.model))) throw new ApiError(400, 'Use a model id from GET /v1/models');
  if ((body.n !== undefined && body.n !== 1) || (body.stream !== undefined && typeof body.stream !== 'boolean')) throw new ApiError(400, 'Use one text completion');
  let conversation = conversationPrompt(body);
  if (!conversation.attachment) {
    try { await prepareSessionPrompt(conversation.text, { autoSkills: [] }); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes('exceed the delivery limit')) throw error;
      conversation = conversationPrompt(body, true);
    }
  }
  return { ...conversation, stream: body.stream === true, model: body.model, reasoningEffort: body.reasoning_effort as ReasoningEffort | undefined };
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  if (req.headers['content-encoding'] || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new ApiError(415, 'Send uncompressed application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) { req.resume(); throw new ApiError(413, 'Request body exceeds 8 MiB'); }
    chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new ApiError(400, 'Invalid JSON'); }
}

async function complete(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const prompt = await promptFor(await readBody(req));
  if (!actionsAllowed()) throw new ApiError(403, 'Control API actions are disabled');
  if (!(await bridgeStatus()).present) throw new ApiError(503, 'Open the CoS browser and sign in to ChatGPT before using this provider');
  if (getConfig().ui.chatBrowser === 'cos' && cosBrowserSignedIn() === false) throw new ApiError(503, 'ChatGPT is signed out; use the login window before sending requests');
  if (res.destroyed) return;
  if (active) throw new ApiError(429, 'One completion is already running');
  const controller = new AbortController();
  active = controller;
  const configuredTimeout = Number(process.env.COS_OPENAI_API_TIMEOUT_MS ?? 180_000);
  const timeout = Number.isInteger(configuredTimeout) && configuredTimeout > 0 && configuredTimeout <= 900_000 ? configuredTimeout : 180_000;
  const timer = setTimeout(() => controller.abort(new ApiError(504, 'ChatGPT did not finish before the deadline; the prompt was not retried')), timeout);
  const disconnected = () => { if (!res.writableEnded) controller.abort(new ApiError(499, 'Caller disconnected')); };
  res.once('close', disconnected);
  const id = randomUUID();
  let admitted = false;
  let ownedMarker: string | undefined;
  let finished = false;
  let turnId: string | undefined;
  let questionId: string | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    const selection = await selectedModel(controller.signal, prompt.model, prompt.reasoningEffort);
    const retained = prompt.attachment ? new Set((await listInputs()).filter(row => !['sent', 'failed', 'cancelled'].includes(row.state)).flatMap(row => row.attachments?.map(file => file.id) ?? [])) : new Set<string>();
    const attachments = prompt.attachment ? [await stageInputAttachment({ name: prompt.attachment.name, bytes: Buffer.from(prompt.attachment.text) }, retained)] : undefined;
    controller.signal.throwIfAborted();
    if (!actionsAllowed()) throw new ApiError(403, 'Control API actions are disabled');
    const marker = path.join(directory, 'pending-' + id);
    await fs.writeFile(marker, '', { mode: 0o600, flag: 'wx' });
    ownedMarker = marker;
    controller.signal.throwIfAborted();
    if (!actionsAllowed()) throw new ApiError(403, 'Control API actions are disabled');
    // Text-only browser delivery needs recording and pairing, not an MCP tunnel or tools.
    await sendDesktopInput({ id, sessionId: null, text: prompt.text, mode: 'auto', dueAt: Date.now(),
      ...selection, ...(attachments ? { attachments } : {}), authoredSource: 'text' }, false);
    admitted = true;
    if (prompt.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write(': waiting\n\n');
      heartbeat = setInterval(() => { if (!res.destroyed) res.write(': waiting\n\n'); }, 15_000);
    }
    let cursor = 0;
    const finals = new Map<string, Extract<SessionEvent, { kind: 'assistant_message' }>>();
    const nativeFinals = new Map<string, Extract<SessionEvent, { kind: 'assistant_message' }>>();
    let ended: Extract<SessionEvent, { kind: 'turn_end' }> | undefined;
    while (true) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!actionsAllowed()) throw new ApiError(403, 'Control API actions were disabled');
      const page = await readSessionEvents(id, { from: cursor, limit: 100 });
      if (page) {
        const previousTurn = turnId;
        for (const event of page.events) {
          if (event.kind === 'user_message' && event.inputId === id) {
            if (selection.model) {
              if (!event.model || !event.reasoningEffort) continue;
              if (resolveChatModel(getChatModels().models, event.model)?.id !== selection.model || event.reasoningEffort !== selection.reasoningEffort) throw new ApiError(502, 'The delivered model or reasoning effort did not match the requested settings');
            }
            if (event.messageId) questionId = event.messageId;
            else turnId = event.turnId;
          }
          if (event.kind === 'assistant_message' && event.source === 'extension' && event.final && event.messageId && !event.turnId) nativeFinals.set(event.messageId, event);
          if (!turnId || !event.turnId || responseTurnId(page.summary.timelineTurns, event.turnId) !== turnId) continue;
          if (event.kind === 'chat_error' && event.blocking) throw new ApiError(502, 'ChatGPT reported a blocking error');
          if (event.kind === 'assistant_message' && event.final && event.messageId) finals.set(event.messageId, event);
          if (event.kind === 'turn_end') ended = event;
        }
        cursor = page.nextFrom;
        if (questionId && !turnId) {
          const owners = [...new Set(Object.entries(page.summary.timelineTurns ?? {})
            .filter(([, turn]) => turn.questionId === questionId)
            .map(([owner]) => responseTurnId(page.summary.timelineTurns, owner)))];
          if (owners.length > 1) throw new ApiError(502, 'The request has multiple recorded responses; no answer was guessed');
          turnId = owners[0];
        }
        // Input attribution can arrive after the native answer. Replay this request's own
        // journal once the exact turn is known; a publication cursor cannot recover old rows.
        if (!previousTurn && turnId) { cursor = 0; continue; }
        if (ended && ended.outcome !== 'completed') throw new ApiError(502, 'The ChatGPT turn did not complete');
        // Native file answers can hydrate as terminal messages without generation events.
        // The fresh response token proves this request, while the exact latest question and
        // absence of a running/recorded turn prevent a different send from lending authority.
        const tokenBound = questionId && !turnId && !Object.keys(page.summary.timelineTurns ?? {}).length &&
          page.summary.activeTurnId === null && page.summary.nativeQuestion?.messageId === questionId
          ? [...nativeFinals.values()].filter(event => prompt.matchesReply(event.message.text)) : [];
        if (tokenBound.length > 1) throw new ApiError(502, 'Multiple native final responses match this request; no answer was guessed');
        if (tokenBound.length === 1) finals.set(tokenBound[0]!.messageId!, tokenBound[0]!);
        if ((ended || tokenBound.length === 1) && finals.size) {
          if ([...finals.values()].some(event => event.message.truncated)) throw new ApiError(502, 'The recorded answer is truncated');
          const content = [...finals.values()].map(event => redactSecretText(event.message.text)).join('\n\n');
          if (content.length > 256_000) throw new ApiError(502, 'The recorded answer exceeds the 256,000 character output limit');
          const result = prompt.reply(content);
          // Finish disk cleanup before publishing a tool call: a fast harness can
          // send its result immediately after HTTP end, before an awaited finally.
          if (ownedMarker) { await fs.rm(ownedMarker); ownedMarker = undefined; }
          const common = { id: 'chatcmpl-' + id, created: Math.floor(Date.now() / 1000), model: selection.model ?? 'chatgpt-default' };
          if (prompt.stream) {
            // Buffered SSE: publish verified complete text, never commentary or a guessed delta.
            const delta = { role: 'assistant', ...result.message, ...(result.message.tool_calls ? { tool_calls: result.message.tool_calls.map((call, index) => ({ index, ...call })) } : {}) };
            res.write('data: ' + JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: result.finishReason }] }) + '\n\n');
            res.end('data: [DONE]\n\n');
          } else reply(res, 200, { ...common, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', ...result.message }, finish_reason: result.finishReason }] });
          finished = true;
          return;
        }
        if (page.events.length === 100) continue;
      }
      const row = (await listInputs()).find(row => row.id === id);
      if (row?.error || row?.state === 'failed' || row?.state === 'cancelled') throw new ApiError(502, 'CoS could not deliver the prompt; check its connection and outbox');
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(poll); controller.signal.removeEventListener('abort', done); resolve(); };
        const poll = setTimeout(done, 250);
        controller.signal.addEventListener('abort', done, { once: true });
        if (controller.signal.aborted) done();
      });
    }
  } finally {
    clearTimeout(timer);
    clearInterval(heartbeat);
    res.off('close', disconnected);
    let releaseMarker = finished || !admitted;
    if (admitted && !finished) {
      try {
        // This listener owns the opening row. The general control API deliberately cannot
        // cancel arbitrary opening chats; use the composer's cancellation for this exact id.
        await cancelDesktopInput(id);
        releaseMarker = true;
        if (turnId && actionsAllowed()) await serveAction('POST', `/v1/sessions/${id}/stop`, { turnId });
      } catch { /* A revoked permission or changed turn must not be overridden. */ }
    }
    if (ownedMarker && releaseMarker) await fs.rm(ownedMarker, { force: true }).catch(() => logWarn('OpenAI coding API: pending request marker could not be cleared'));
    active = null;
  }
}

export async function startOpenAiApi(userDataDir: string): Promise<void> {
  if (server) return;
  directory = path.join(userDataDir, 'openai-api');
  // These private markers are written before admission. A crashed caller has no
  // receiver after restart: withdraw only its owned outbox rows, never resend them.
  for (const name of await fs.readdir(directory).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return [] as string[];
  })) {
    const pending = /^pending-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.exec(name);
    if (!pending) continue;
    await cancelDesktopInput(pending[1]!);
    await fs.rm(path.join(directory, name));
  }
  const setting = process.env.COS_OPENAI_API_PORT;
  if (setting === undefined || !actionsAllowed()) return;
  if (!/^\d{1,5}$/.test(setting) || Number(setting) > 65535) throw new Error('COS_OPENAI_API_PORT must be a port number');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const keyFile = path.join(directory, 'key');
  try { await fs.writeFile(keyFile, randomBytes(32).toString('base64url') + '\n', { mode: 0o600, flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const key = (await fs.readFile(keyFile, 'utf8')).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('The OpenAI API key file is not valid');
  const instance = http.createServer((req, res) => {
    const port = (instance.address() as { port: number }).port;
    if (req.headers.origin !== undefined || ![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host ?? '')) {
      return reply(res, 403, { error: { message: 'Local callers only', type: 'permission_error' } });
    }
    const supplied = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from('Bearer ' + key);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return reply(res, 401, { error: { message: 'Invalid API key', type: 'authentication_error' } });
    }
    if (!actionsAllowed()) return reply(res, 403, { error: { message: 'Control API actions are disabled', type: 'permission_error' } });
    if (req.method === 'GET' && req.url === '/v1/models') {
      const models = getChatModels().models.map(model => ({ id: model.id, name: model.label, reasoning_efforts: model.efforts }));
      return reply(res, 200, { object: 'list', data: [...models, { id: 'chatgpt-latest' }].map(model => ({ ...model, object: 'model', created: 0, owned_by: 'chat-on-steroids' })) });
    }
    if (req.method === 'GET' && req.url === '/v1/health') {
      void bridgeStatus().then(bridge => {
        const builtin = getConfig().ui.chatBrowser === 'cos';
        const signedIn = builtin ? cosBrowserSignedIn() : null;
        const catalog = getChatModels();
        const observed = catalog.state === 'ready' && !catalog.error && catalog.observedAt !== null && Date.now() - catalog.observedAt < 3_600_000;
        reply(res, 200, { browserConnected: bridge.present === true, signedIn, ready: bridge.present === true && (builtin ? signedIn === true : observed) });
      }).catch(() => reply(res, 503, { error: { message: 'Browser state is unavailable', type: 'api_error' } }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/login') {
      const browser = getConfig().ui.chatBrowser ?? 'chrome';
      if (Date.now() - lastLoginAt < 60_000) {
        res.setHeader('retry-after', '60');
        return reply(res, 429, { error: { message: 'Use the existing login window; wait before reopening it', type: 'api_error' } });
      }
      lastLoginAt = Date.now();
      const opening = browser === 'cos' ? import('./cos-browser/selection.js').then(async ({ loadCosBrowser }) => {
        await (await loadCosBrowser()).showSignIn();
      }) : openBrowserSignIn(browser);
      void opening.then(() => reply(res, 202, { opened: true }))
        .catch(() => reply(res, 503, { error: { message: 'The browser could not open', type: 'api_error' } }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      if (requests.size >= 4) return reply(res, 429, { error: { message: 'Too many requests', type: 'api_error' } });
      const work = complete(req, res).catch(error => {
        const known = error instanceof ApiError || error instanceof ProtocolError;
        if (!known) logWarn('OpenAI text API: request failed');
        if (!res.destroyed && !res.headersSent) reply(res, known ? error.status : 502, { error: {
          message: known ? error.message : 'CoS could not complete the request; check the app', type: 'api_error'
        } });
        else if (!res.destroyed) res.end('data: ' + JSON.stringify({ error: {
          message: known ? error.message : 'CoS could not complete the request; check the app', type: 'api_error'
        } }) + '\n\ndata: [DONE]\n\n');
      });
      requests.add(work);
      void work.finally(() => requests.delete(work));
      return;
    }
    return reply(res, 404, { error: { message: 'Not found', type: 'invalid_request_error' } });
  });
  instance.headersTimeout = 5_000;
  instance.requestTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    instance.once('error', reject);
    instance.listen(Number(setting), '127.0.0.1', () => { instance.off('error', reject); resolve(); });
  });
  try {
    await fs.writeFile(path.join(directory, 'endpoint.json'), JSON.stringify({
      port: (instance.address() as { port: number }).port, pid: process.pid
    }), { mode: 0o600 });
  } catch (error) { instance.close(); throw error; }
  server = instance;
}

function reply(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

export async function stopOpenAiApi(): Promise<void> {
  const instance = server;
  server = null;
  if (!instance) return;
  active?.abort(new ApiError(503, 'CoS is shutting down'));
  instance.closeAllConnections();
  await Promise.all(requests);
  await fs.rm(path.join(directory, 'endpoint.json'), { force: true });
  await new Promise<void>(resolve => instance.close(() => resolve()));
}
