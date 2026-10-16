/** Real loopback HTTP, the durable outbox and recorded session events. Only OS/browser effects are replaced. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';
import type { ReasoningEffort } from '../src/shared/session.js';
import type { ChatModelOption } from '../src/shared/chat-models.js';

vi.mock('electron', () => ({
  app: { on: vi.fn(), getPath: () => '', getVersion: () => '0.0.0', getAppPath: () => process.cwd(), isPackaged: false },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString(), shouldReEncrypt: false })
  },
  BrowserWindow: class {}, clipboard: { readText: () => '', writeText: () => undefined },
  shell: { openExternal: async () => undefined, openPath: async () => '' }, nativeTheme: { themeSource: 'system' }
}));
const gate = vi.hoisted(() => ({ enabled: true, allowActions: true, connected: true, companion: true, revokeAtBridge: false, browser: 'cos' as 'cos' | 'chrome' }));
const signIn = vi.hoisted(() => vi.fn(async () => undefined));
const externalSignIn = vi.hoisted(() => vi.fn(async () => 'chrome'));
vi.mock('../src/main/browser.js', async original => ({ ...await original<typeof import('../src/main/browser.js')>(), openBrowserSignIn: externalSignIn }));
vi.mock('../src/main/cos-browser/selection.js', () => ({ loadCosBrowser: async () => ({ showSignIn: signIn }) }));
vi.mock('../src/main/config.js', async (original) => {
  const actual = await original<typeof import('../src/main/config.js')>();
  return { ...actual, getConfig: () => ({ ...actual.getConfig(), ui: { ...actual.getConfig().ui, chatBrowser: gate.browser }, controlApi: { enabled: gate.enabled, allowActions: gate.allowActions } }) };
});
vi.mock('../src/main/connection.js', async (original) => {
  const actual = await original<typeof import('../src/main/connection.js')>();
  return { ...actual, connect: async () => undefined, getStatus: () => ({ ...actual.getStatus(), state: gate.connected ? 'connected' : 'disconnected' }), onStatusChange: () => () => undefined };
});
vi.mock('../src/main/bridge.js', async (original) => ({ ...await original<typeof import('../src/main/bridge.js')>(), startBridge: async () => true, bridgeStatus: async () => {
  if (gate.revokeAtBridge) gate.allowActions = false;
  return { present: gate.companion };
} }));
vi.mock('../src/main/browser-startup.js', async (original) => ({ ...await original<typeof import('../src/main/browser-startup.js')>(), wakeBrowserUrl: async () => undefined }));

const { initConfigPath } = await import('../src/main/config.js');
const { initSecretsPath } = await import('../src/main/secrets.js');
const { flushDurable, initDurableStore, resetDurableForTests } = await import('../src/main/durable.js');
const { initSessionStore, resetSessionStoreForTests, createSession, appendEvent } = await import('../src/main/session/store.js');
const { listInputs, resetInputForTests } = await import('../src/main/session/input.js');
const { resetInputStartupForTests, sendDesktopInput, cancelDesktopInput } = await import('../src/main/session/start-input.js');
const { readInputAttachmentChunk } = await import('../src/main/session/input-attachments.js');
const api = await import('../src/main/control-api.js');
const { setCosBrowserSignedIn } = await import('../src/main/cos-browser/sign-in.js');
const chatModels = await import('../src/main/chat-models.js');
let dir: string;
let port: number;
let key: string;

beforeAll(async () => {
  dir = await makeTempDir('clf-openai-api-');
  initConfigPath(dir); initSecretsPath(dir); initSessionStore(dir); initDurableStore(dir);
  api.initControlApiPath(dir);
  process.env.COS_OPENAI_API_PORT = '0';
  await api.startControlApi();
});
afterAll(async () => {
  delete process.env.COS_OPENAI_API_PORT;
  await api.stopControlApi(); resetInputStartupForTests();
  await flushDurable(); resetInputForTests(); resetDurableForTests(); resetSessionStoreForTests();
  await removeTempDir(dir);
});

it('publishes a separate OpenAI endpoint only when explicitly enabled', async () => {
  const endpoint = await fs.readFile(path.join(dir, 'openai-api', 'endpoint.json'), 'utf8').catch(() => null);
  expect(endpoint, 'an opted-in API must publish its bound loopback endpoint').not.toBeNull();
  port = JSON.parse(endpoint!).port;
  key = (await fs.readFile(path.join(dir, 'openai-api', 'key'), 'utf8')).trim();
  const refused = await fetch(`http://127.0.0.1:${port}/v1/models`);
  expect(refused.status).toBe(401);
});

function request(body?: object, headers: Record<string, string> = {}, route = '/v1/chat/completions') {
  return fetch(`http://127.0.0.1:${port}${route}`, { method: body ? 'POST' : 'GET',
    headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}) });
}
const prompt = (extra: object = {}) => ({ model: 'chatgpt-default', messages: [{ role: 'user', content: 'Write a pure addition function.' }], ...extra });
async function admitted(before: Set<string>) {
  let found: Awaited<ReturnType<typeof listInputs>>[number] | undefined;
  await vi.waitFor(async () => { found = (await listInputs()).find(row => !before.has(row.id)); expect(found).toBeDefined(); });
  return found!;
}
async function answer(id: string, text: string, truncated = false, outcome: 'completed' | 'interrupted' = 'completed', selection: { model?: string; reasoningEffort?: ReasoningEffort } = {}) {
  await createSession({ reservedId: id, conversationId: null, origin: { kind: 'desktop', fromSessionId: null, agentId: null, task: '' } });
  const base = { source: 'extension' as const, time: Date.now() };
  await appendEvent(id, { ...base, ...selection, kind: 'user_message', inputId: id, turnId: 'request-turn', message: { text: 'request', chars: 7, truncated: false } });
  await appendEvent(id, { ...base, kind: 'assistant_message', turnId: 'other-turn', messageId: 'other', final: true, message: { text: 'WRONG TURN', chars: 10, truncated: false } });
  await appendEvent(id, { ...base, kind: 'turn_end', turnId: 'other-turn', outcome: 'completed' });
  await appendEvent(id, { ...base, kind: 'assistant_message', turnId: 'request-turn', messageId: 'answer', final: true, message: { text, chars: text.length, truncated } });
  await appendEvent(id, { ...base, kind: 'turn_end', turnId: 'request-turn', outcome });
}

it('returns complete code beyond 4,000 characters from the exact new chat and turn', async () => {
  const before = new Set((await listInputs()).map(row => row.id));
  const pending = request(prompt({ messages: [{ role: 'system', content: 'Use TypeScript.' }, { role: 'user', content: 'Write code.' }] }));
  const row = await admitted(before);
  expect(row.sessionId).toBe(row.id);
  expect(row.text).toContain('Use TypeScript.');
  const code = 'export const add = (a: number, b: number) => a + b;\n'.repeat(150);
  await answer(row.id, code);
  const response = await pending;
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ object: 'chat.completion', model: 'chatgpt-default',
    choices: [{ index: 0, message: { role: 'assistant', content: code }, finish_reason: 'stop' }] });
});

it('serves OpenAI SSE envelopes after the complete recorded answer', async () => {
  const before = new Set((await listInputs()).map(row => row.id));
  const pending = request(prompt({ stream: true }));
  const row = await admitted(before);
  await answer(row.id, 'def add(a, b):\n    return a + b');
  const response = await pending;
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const frames = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6));
  expect(frames.at(-1)).toBe('[DONE]');
  expect(JSON.parse(frames[0]!)).toMatchObject({ object: 'chat.completion.chunk', choices: [{ delta: { role: 'assistant', content: 'def add(a, b):\n    return a + b' } }] });
});

it('rejects malformed tools, images, multiple choices and unknown models without sending', async () => {
  const before = (await listInputs()).length;
  for (const extra of [{ tools: [{ type: 'function' }] }, { n: 2 }, { model: 'invented' },
    { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/image.png' } }] }] },
    ]) {
    expect((await request(prompt(extra))).status).toBe(400);
  }
  expect((await listInputs()).length).toBe(before);
});

it('refuses browser origins, foreign Hosts and wrong keys', async () => {
  expect((await request(undefined, { origin: 'http://localhost' }, '/v1/models')).status).toBe(403);
  const foreignHost = await new Promise<number>((resolve, reject) => {
    const call = http.get({ hostname: '127.0.0.1', port, path: '/v1/models', headers: { host: 'example.com', authorization: 'Bearer ' + key } }, response => { response.resume(); resolve(response.statusCode!); });
    call.on('error', reject);
  });
  expect(foreignHost).toBe(403);
  expect((await request(undefined, { authorization: 'Bearer wrong' }, '/v1/models')).status).toBe(401);
});

it('revokes existing keys immediately when actions are disabled', async () => {
  gate.allowActions = false;
  try { expect((await request(prompt())).status).toBe(403); }
  finally { gate.allowActions = true; }
});

it.each([{ clipped: true, outcome: 'completed' as const }, { clipped: false, outcome: 'interrupted' as const }])('does not claim clipped or interrupted code is complete: %j', async ({ clipped, outcome }) => {
  const before = new Set((await listInputs()).map(row => row.id));
  const pending = request(prompt());
  const row = await admitted(before);
  await answer(row.id, 'partial code', clipped, outcome);
  expect((await pending).status).toBe(502);
});

it('cancels an unsent timed-out input without retrying', async () => {
  process.env.COS_OPENAI_API_TIMEOUT_MS = '100';
  try {
    const before = new Set((await listInputs()).map(row => row.id));
    const pending = request(prompt());
    const row = await admitted(before);
    expect((await pending).status).toBe(504);
    await vi.waitFor(async () => expect((await listInputs()).find(input => input.id === row.id)?.state).toBe('cancelled'));
    expect((await listInputs()).filter(input => !before.has(input.id))).toHaveLength(1);
  } finally { delete process.env.COS_OPENAI_API_TIMEOUT_MS; }
});

it('queues overlapping harness turns without admitting two browser sends or causing a busy cooldown', async () => {
  process.env.COS_OPENAI_API_TIMEOUT_MS = '2000';
  try {
    const before = new Set((await listInputs()).map(row => row.id));
    const first = request(prompt());
    const row = await admitted(before);
    const second = request(prompt());
    await new Promise(resolve => setTimeout(resolve, 50));
    expect((await listInputs()).filter(input => !before.has(input.id))).toHaveLength(1);
    await answer(row.id, 'first answer');
    expect((await first).status).toBe(200);
    const next = await admitted(new Set([...before, row.id]));
    await answer(next.id, 'second answer');
    expect((await second).status).toBe(200);
  } finally { delete process.env.COS_OPENAI_API_TIMEOUT_MS; }
});

it('expires a queued caller at its own deadline without cancelling or bypassing the active request', async () => {
  process.env.COS_OPENAI_API_TIMEOUT_MS = '1000';
  try {
    const before = new Set((await listInputs()).map(row => row.id));
    const first = request(prompt());
    const row = await admitted(before);
    process.env.COS_OPENAI_API_TIMEOUT_MS = '30';
    const started = Date.now();
    const queued = await request(prompt());
    expect(queued.status).toBe(504);
    expect(Date.now() - started).toBeLessThan(250);
    expect((await listInputs()).filter(input => !before.has(input.id))).toHaveLength(1);
    await answer(row.id, 'still the active request');
    expect((await first).status).toBe(200);
  } finally { delete process.env.COS_OPENAI_API_TIMEOUT_MS; }
});

it('retains the provider key across restarts and removes the endpoint on stop', async () => {
  await api.stopControlApi();
  expect(await fs.stat(path.join(dir, 'openai-api', 'endpoint.json')).catch(() => null)).toBeNull();
  await api.startControlApi();
  expect((await fs.readFile(path.join(dir, 'openai-api', 'key'), 'utf8')).trim()).toBe(key);
  port = JSON.parse(await fs.readFile(path.join(dir, 'openai-api', 'endpoint.json'), 'utf8')).port;
  expect((await request(undefined, {}, '/v1/models')).status).toBe(200);
});

it('does not send when the browser companion is offline', async () => {
  const before = (await listInputs()).length;
  gate.companion = false;
  process.env.COS_OPENAI_API_TIMEOUT_MS = '100';
  try { expect((await request(prompt())).status).toBe(503); }
  finally { gate.companion = true; delete process.env.COS_OPENAI_API_TIMEOUT_MS; }
  expect((await listInputs()).length).toBe(before);
});

it('can answer text without connecting an MCP tunnel', async () => {
  gate.connected = false;
  const before = new Set((await listInputs()).map(row => row.id));
  const pending = request(prompt());
  try {
    const row = await admitted(before);
    await answer(row.id, 'text without a connector');
    expect((await pending).status).toBe(200);
  } finally { gate.connected = true; }
});

it('waits for late input attribution before returning an already recorded reply', async () => {
  const before = new Set((await listInputs()).map(row => row.id));
  const pending = request(prompt());
  const row = await admitted(before);
  await createSession({ reservedId: row.id });
  const base = { source: 'extension' as const, time: Date.now(), turnId: 'late-turn' };
  await appendEvent(row.id, { ...base, kind: 'assistant_message', final: true, messageId: 'late-answer', message: { text: 'correct late reply', chars: 18, truncated: false } });
  await appendEvent(row.id, { ...base, kind: 'turn_end', outcome: 'completed' });
  await new Promise(resolve => setTimeout(resolve, 300));
  await appendEvent(row.id, { ...base, kind: 'user_message', inputId: row.id, message: { text: 'request', chars: 7, truncated: false } });
  const response = await pending;
  expect(response.status).toBe(200);
  expect((await response.json()).choices[0].message.content).toBe('correct late reply');
}, 5_000);

it('opens the existing built-in sign-in flow on demand without returning cookies', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const response = await request({}, {}, '/v1/login');
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ opened: true });
  expect(signIn).toHaveBeenCalledOnce();
  expect((await request({}, {}, '/v1/login')).status).toBe(429);
  expect(signIn).toHaveBeenCalledOnce();
  const health = await request(undefined, {}, '/v1/health');
  expect(await health.json()).toEqual({ browserConnected: true, signedIn: null, ready: false });
  vi.setSystemTime(Date.now() + 61_000);
  gate.browser = 'chrome';
  try {
    const chrome = await request({}, {}, '/v1/login');
    expect(chrome.status).toBe(202);
    expect(externalSignIn).toHaveBeenCalledWith('chrome');
  } finally { gate.browser = 'cos'; vi.useRealTimers(); }
});

it('fails immediately without queuing a prompt when the built-in browser is signed out', async () => {
  const before = (await listInputs()).length;
  setCosBrowserSignedIn(false);
  process.env.COS_OPENAI_API_TIMEOUT_MS = '100';
  try { expect((await request(prompt())).status).toBe(503); }
  finally { setCosBrowserSignedIn(null); delete process.env.COS_OPENAI_API_TIMEOUT_MS; }
  expect((await listInputs()).length).toBe(before);
});

it('does not admit a chat if consent is revoked during browser readiness', async () => {
  const before = (await listInputs()).length;
  gate.revokeAtBridge = true;
  try { expect((await request(prompt())).status).toBe(403); }
  finally { gate.revokeAtBridge = false; gate.allowActions = true; }
  expect((await listInputs()).length).toBe(before);
});

it('rejects malformed JSON and invalid UTF-8 without changing the outbox', async () => {
  const before = (await listInputs()).length;
  process.env.COS_OPENAI_API_TIMEOUT_MS = '100';
  try {
    for (const body of [Buffer.from('{broken'), Buffer.concat([
      Buffer.from('{"model":"chatgpt-default","messages":[{"role":"user","content":"'),
      Buffer.from([0x80]), Buffer.from('"}]}')
    ])]) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body
      });
      expect(response.status).toBe(400);
    }
  } finally { delete process.env.COS_OPENAI_API_TIMEOUT_MS; }
  expect((await listInputs()).length).toBe(before);
});

function modelPolicy(models: ChatModelOption[], state: 'ready' | 'unknown' = 'ready') {
  process.env.COS_OPENAI_MODEL = 'latest';
  process.env.COS_OPENAI_REASONING_EFFORT = 'xhigh';
  const catalog = { state, models, requestedAt: null, observedAt: Date.now() };
  const read = vi.spyOn(chatModels, 'getChatModels').mockReturnValue(catalog);
  const refresh = vi.spyOn(chatModels, 'requestChatModels').mockImplementation(allowOpen => {
    if (allowOpen !== true) throw new Error('A requested model refresh must be able to use a clean discovery helper');
    return catalog;
  });
  return () => {
    read.mockRestore(); refresh.mockRestore();
    delete process.env.COS_OPENAI_MODEL; delete process.env.COS_OPENAI_REASONING_EFFORT;
  };
}

it('pins the newest observed GPT generation at Extra High and requires matching delivery proof', async () => {
  const restore = modelPolicy([
    { id: 'gpt-6.9', label: 'GPT-6.9', efforts: ['xhigh'] },
    { id: 'gpt-6.10-pro', label: 'GPT-6.10 Pro', efforts: ['pro'] },
    { id: 'gpt-6.10', label: 'GPT-6.10', efforts: ['medium', 'xhigh'] }
  ]);
  try {
    const before = new Set((await listInputs()).map(row => row.id));
    const pending = request(prompt());
    const row = await admitted(before);
    await answer(row.id, 'latest code', false, 'completed', { model: 'gpt-6.10', reasoningEffort: 'xhigh' });
    const response = await pending;
    expect(row).toMatchObject({ model: 'gpt-6.10', reasoningEffort: 'xhigh' });
    expect(response.status).toBe(200);
    expect((await response.json()).model).toBe('gpt-6.10');
  } finally { restore(); }
});

it.each(['unknown catalog', 'newest lacks Extra High'])('never falls back to an older model or lower effort: %s', async scenario => {
  const restore = modelPolicy([
    { id: 'gpt-6', label: 'GPT-6', efforts: ['xhigh'] },
    { id: 'gpt-7', label: 'GPT-7', efforts: ['high'] }
  ], scenario === 'unknown catalog' ? 'unknown' : 'ready');
  process.env.COS_OPENAI_API_TIMEOUT_MS = '100';
  try {
    const before = (await listInputs()).length;
    expect((await request(prompt())).status).toBe(503);
    expect((await listInputs()).length).toBe(before);
  } finally { restore(); delete process.env.COS_OPENAI_API_TIMEOUT_MS; }
});

it('rejects a reply delivered with the wrong reasoning effort', async () => {
  const restore = modelPolicy([{ id: 'gpt-6', label: 'GPT-6', efforts: ['high', 'xhigh'] }]);
  try {
    const before = new Set((await listInputs()).map(row => row.id));
    const pending = request(prompt());
    const row = await admitted(before);
    await answer(row.id, 'wrong settings', false, 'completed', { model: 'gpt-6', reasoningEffort: 'high' });
    expect((await pending).status).toBe(502);
  } finally { restore(); }
});

it('sends streaming keepalives while thinking, without publishing unverified code', async () => {
  const before = new Set((await listInputs()).map(row => row.id));
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 750);
  try {
    const pending = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify(prompt({ stream: true })), signal: controller.signal
    });
    const row = await admitted(before);
    const response = await pending.catch(() => null);
    expect(response, 'stream headers must arrive before the model finishes thinking').not.toBeNull();
    const reader = response!.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toMatch(/^: waiting/);
    expect(first).not.toContain('choices');
    clearTimeout(deadline);
    await answer(row.id, 'verified code');
    let remaining = '';
    while (true) { const chunk = await reader.read(); if (chunk.done) break; remaining += new TextDecoder().decode(chunk.value); }
    expect(remaining).toContain('verified code');
    expect(remaining).toContain('[DONE]');
  } finally { clearTimeout(deadline); controller.abort(); }
});

it('reports a failed streaming turn as an error rather than a successful code completion', async () => {
  const before = new Set((await listInputs()).map(row => row.id));
  const pending = request(prompt({ stream: true }));
  const row = await admitted(before);
  await answer(row.id, 'clipped code', true);
  const response = await pending;
  const body = await response.text();
  expect(body).toContain('"error"');
  expect(body).not.toContain('"choices"');
  expect(body).not.toContain('clipped code');
});

it('reports external Chrome readiness from a fresh account catalog without claiming cookie access', async () => {
  gate.browser = 'chrome';
  const restore = modelPolicy([{ id: 'gpt-6', label: 'GPT-6', efforts: ['xhigh'] }]);
  try {
    const response = await request(undefined, {}, '/v1/health');
    expect(await response.json()).toEqual({ browserConnected: true, signedIn: null, ready: true });
  } finally { restore(); gate.browser = 'cos'; }
});

it('does not queue a prompt when model inspection finishes after its deadline', async () => {
  const restore = modelPolicy([{ id: 'gpt-6', label: 'GPT-6', efforts: ['xhigh'] }]);
  const ready = chatModels.getChatModels();
  vi.mocked(chatModels.getChatModels).mockReturnValueOnce({ ...ready, state: 'pending' });
  process.env.COS_OPENAI_API_TIMEOUT_MS = '20';
  try {
    const before = (await listInputs()).length;
    expect((await request(prompt())).status).toBe(504);
    expect((await listInputs()).length).toBe(before);
  } finally { restore(); delete process.env.COS_OPENAI_API_TIMEOUT_MS; }
});

it('uses the recorded question-to-response relation when the native user message has no turn id', async () => {
  const restore = modelPolicy([{ id: 'gpt-6', label: 'GPT-6', efforts: ['xhigh'], aliases: ['gpt-6-thinking'] }]);
  process.env.COS_OPENAI_API_TIMEOUT_MS = '750';
  try {
    const before = new Set((await listInputs()).map(row => row.id));
    const pending = request(prompt());
    const row = await admitted(before);
    const base = { source: 'extension' as const, time: Date.now() };
    await createSession({ reservedId: row.id });
    await appendEvent(row.id, { ...base, kind: 'user_message', messageId: 'native-question', inputId: row.id,
      model: 'gpt-6-thinking', reasoningEffort: 'xhigh', message: { text: 'request', chars: 7, truncated: false } });
    await appendEvent(row.id, { ...base, kind: 'turn_start', turnId: 'native-generation' });
    await appendEvent(row.id, { ...base, kind: 'assistant_message', turnId: 'native-generation', messageId: 'native-answer',
      final: true, message: { text: 'the correct response', chars: 20, truncated: false } });
    await appendEvent(row.id, { ...base, kind: 'turn_end', turnId: 'native-generation', outcome: 'completed' });
    await appendEvent(row.id, { ...base, kind: 'user_message', messageId: 'another-question', inputId: 'another-input',
      message: { text: 'another request', chars: 15, truncated: false } });
    await appendEvent(row.id, { ...base, kind: 'turn_start', turnId: 'later-generation' });
    await appendEvent(row.id, { ...base, kind: 'assistant_message', turnId: 'later-generation', messageId: 'later-answer',
      final: true, message: { text: 'WRONG LATER RESPONSE', chars: 20, truncated: false } });
    await appendEvent(row.id, { ...base, kind: 'turn_end', turnId: 'later-generation', outcome: 'completed' });
    const response = await pending;
    expect(response.status).toBe(200);
    expect((await response.json()).choices[0].message.content).toBe('the correct response');
  } finally { restore(); delete process.env.COS_OPENAI_API_TIMEOUT_MS; }
});

it('publishes and accepts the real account model ids, including Pro with its own power tier', async () => {
  const restore = modelPolicy([
    { id: 'gpt-6', label: 'GPT-6', efforts: ['medium','high','xhigh'] },
    { id: 'gpt-6-pro', label: 'GPT-6 Pro', efforts: ['pro'] },
    { id: 'gpt-5-6', label: 'GPT-5.6', efforts: ['xhigh'] }
  ]);
  try {
    const catalog = await request(undefined, {}, '/v1/models');
    expect((await catalog.json()).data.map((model: {id:string}) => model.id)).toEqual(expect.arrayContaining(['gpt-6','gpt-6-pro','gpt-5-6','chatgpt-latest']));
    for (const [model, effort] of [['gpt-6','xhigh'], ['gpt-6-pro','pro'], ['gpt-5-6','xhigh']] as const) {
      const before = new Set((await listInputs()).map(row => row.id));
      const pending = request(prompt({ model }));
      const row = await admitted(before);
      await answer(row.id, 'correct named model', false, 'completed', { model, reasoningEffort:effort });
      const response = await pending;
      expect(row).toMatchObject({ model, reasoningEffort:effort });
      expect(response.status).toBe(200);
      expect((await response.json()).model).toBe(model);
    }
  } finally { restore(); }
});

it.each(['none', 'medium', 'high', 'xhigh'] as const)('honors 9Router reasoning_effort=%s instead of the service default', async reasoningEffort => {
  const restore = modelPolicy([{ id: 'gpt-6', label: 'GPT-6', efforts: ['none','medium','high','xhigh'] }]);
  try {
    const before = new Set((await listInputs()).map(row => row.id));
    const pending = request(prompt({ model: 'gpt-6', reasoning_effort: reasoningEffort }));
    const row = await admitted(before);
    await answer(row.id, 'requested effort', false, 'completed', { model: 'gpt-6', reasoningEffort });
    const response = await pending;
    expect(row.reasoningEffort).toBe(reasoningEffort);
    expect(response.status).toBe(200);
  } finally { restore(); }
});

it('rejects invalid or unavailable explicit effort without sending or silently substituting Pro', async () => {
  const restore = modelPolicy([
    { id: 'gpt-6', label: 'GPT-6', efforts: ['medium','high','xhigh'] },
    { id: 'gpt-6-pro', label: 'GPT-6 Pro', efforts: ['pro'] }
  ]);
  process.env.COS_OPENAI_API_TIMEOUT_MS = '100';
  try {
    const before = (await listInputs()).length;
    for (const [model, reasoning_effort] of [['gpt-6', 'invented'], ['gpt-6', null], ['gpt-6', 'low'], ['gpt-6-pro', 'xhigh']]) {
      const response = await request(prompt({ model, reasoning_effort }));
      expect(response.status).toBe(400);
    }
    expect((await listInputs()).length).toBe(before);
  } finally { restore(); delete process.env.COS_OPENAI_API_TIMEOUT_MS; }
});

it('exposes the observed effort choices in the model catalog', async () => {
  const restore = modelPolicy([{ id: 'gpt-6', label: 'GPT-6', efforts: ['none','medium','high','xhigh'] }]);
  try {
    const catalog = await (await request(undefined, {}, '/v1/models')).json();
    expect(catalog.data.find((model: { id: string }) => model.id === 'gpt-6')).toMatchObject({ reasoning_efforts: ['none','medium','high','xhigh'] });
  } finally { restore(); }
});

const clientTools = [{ type: 'function', function: { name: 'read_file', description: 'Read a local file', parameters: {
  type: 'object', properties: { path: { type: 'string' } }, required: ['path']
} } }];
function toolEnvelope(text: string, content: string | null, calls: { name: string; arguments: object }[] = []) {
  const token = /response_token=([a-f0-9-]+)/.exec(text)?.[1];
  expect(token, 'tool requests carry an unpredictable response token').toBeDefined();
  return JSON.stringify({ response_token: token, content, tool_calls: calls });
}

it('returns client tool calls and accepts their results on the next completion without running CoS tools', async () => {
  process.env.COS_OPENAI_API_TIMEOUT_MS = '750';
  try {
    let before = new Set((await listInputs()).map(row => row.id));
    const pending = request(prompt({ tools: clientTools, tool_choice: 'auto' }));
    const row = await admitted(before);
    expect(row.text).toContain('read_file');
    await answer(row.id, toolEnvelope(row.text, null, [{ name: 'read_file', arguments: { path: 'canary.txt' } }]));
    const response = await pending;
    expect(response.status).toBe(200);
    const first = (await response.json()).choices[0];
    expect(first.finish_reason).toBe('tool_calls');
    expect(first.message).toMatchObject({ role: 'assistant', content: null, tool_calls: [{ type: 'function', function: { name: 'read_file', arguments: '{"path":"canary.txt"}' } }] });
    expect(first.message.tool_calls[0].id).toMatch(/^call_/);

    before = new Set((await listInputs()).map(row => row.id));
    const followup = request(prompt({ tools: clientTools, messages: [
      { role: 'user', content: 'Read canary.txt' }, first.message,
      { role: 'tool', tool_call_id: first.message.tool_calls[0].id, content: 'CANARY-CONTENT-519' }
    ] }));
    const next = await admitted(before);
    expect(next.text).toContain('CANARY-CONTENT-519');
    expect(next.text).toContain(first.message.tool_calls[0].id);
    await answer(next.id, toolEnvelope(next.text, 'CANARY-CONTENT-519'));
    const final = (await (await followup).json()).choices[0];
    expect(final).toMatchObject({ finish_reason: 'stop', message: { content: 'CANARY-CONTENT-519' } });
    expect(final.message.tool_calls).toBeUndefined();
  } finally { delete process.env.COS_OPENAI_API_TIMEOUT_MS; }
});

it('emits standard streamed tool-call deltas with a tool_calls finish reason', async () => {
  process.env.COS_OPENAI_API_TIMEOUT_MS = '750';
  try {
    const before = new Set((await listInputs()).map(row => row.id));
    const pending = request(prompt({ tools: clientTools, stream: true, parallel_tool_calls: false, tool_choice: { type: 'function', function: { name: 'read_file' } } }));
    const row = await admitted(before);
    await answer(row.id, toolEnvelope(row.text, null, [{ name: 'read_file', arguments: { path: 'unicode-é.txt' } }]));
    const frames = (await (await pending).text()).split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).map(line => JSON.parse(line.slice(6)));
    expect(frames[0].choices[0].delta).toMatchObject({ role: 'assistant', tool_calls: [{ index: 0, type: 'function', function: { name: 'read_file', arguments: '{"path":"unicode-é.txt"}' } }] });
    expect(frames.at(-1).choices[0].finish_reason).toBe('tool_calls');
  } finally { delete process.env.COS_OPENAI_API_TIMEOUT_MS; }
});

it.each(['wrong token', 'unknown tool', 'required without call', 'parallel disabled', 'invalid arguments', 'unstructured answer'])('refuses invalid tool output without publishing an executable call: %s', async scenario => {
  process.env.COS_OPENAI_API_TIMEOUT_MS = '750';
  try {
    const before = new Set((await listInputs()).map(row => row.id));
    const pending = request(prompt({ tools: clientTools, tool_choice: 'required', parallel_tool_calls: false }));
    const row = await admitted(before);
    const calls = [{ name: scenario === 'unknown tool' ? 'delete_everything' : 'read_file', arguments: { path: 'file.txt' } }];
    let output = toolEnvelope(row.text, null, scenario === 'required without call' ? [] : scenario === 'parallel disabled' ? [...calls, ...calls] : calls);
    if (scenario === 'wrong token') output = output.replace(/"response_token":"[^"]+"/, '"response_token":"wrong"');
    if (scenario === 'invalid arguments') output = output.replace('{"path":"file.txt"}', '"not-json"');
    if (scenario === 'unstructured answer') output = 'I will read the file now.';
    await answer(row.id, output);
    const response = await pending;
    expect(response.status).toBe(502);
    expect(await response.json()).not.toHaveProperty('choices');
  } finally { delete process.env.COS_OPENAI_API_TIMEOUT_MS; }
});

it('accepts empty tool lists and tool_choice=none as ordinary text requests', async () => {
  for (const extra of [{ tools: [] }, { tools: clientTools, tool_choice: 'none' }]) {
    const before = new Set((await listInputs()).map(row => row.id));
    const pending = request(prompt(extra));
    const row = await admitted(before);
    await answer(row.id, 'plain answer');
    expect((await (await pending).json()).choices[0].message.content).toBe('plain answer');
  }
});

it('rejects orphan tool results and malformed tool definitions before admission', async () => {
  const before = (await listInputs()).length;
  for (const extra of [
    { messages: [{ role: 'tool', tool_call_id: 'unknown', content: 'result' }] },
    { tools: [{ type: 'function', function: { name: 'bad name', parameters: {} } }] },
    { tools: clientTools, tool_choice: { type: 'function', function: { name: 'missing' } } }
  ]) expect((await request(prompt(extra))).status).toBe(400);
  expect((await listInputs()).length).toBe(before);
});

it('preserves a named tool choice even when its function is called none', async () => {
  process.env.COS_OPENAI_API_TIMEOUT_MS = '750';
  try {
    const before = new Set((await listInputs()).map(row => row.id));
    const pending = request(prompt({ tools: [{ type: 'function', function: { name: 'none', parameters: { type: 'object' } } }],
      tool_choice: { type: 'function', function: { name: 'none' } } }));
    const row = await admitted(before);
    await answer(row.id, toolEnvelope(row.text, null, [{ name: 'none', arguments: {} }]));
    const response = await pending;
    expect(response.status).toBe(200);
    expect((await response.json()).choices[0]).toMatchObject({ finish_reason: 'tool_calls', message: { tool_calls: [{ function: { name: 'none' } }] } });
  } finally { delete process.env.COS_OPENAI_API_TIMEOUT_MS; }
});

it('uploads oversized coding context through native attachments without truncating its beginning, middle or end', async () => {
  process.env.COS_OPENAI_API_TIMEOUT_MS = '2000';
  try {
    const context = 'BEGIN-MARKER-451\n' + 'context '.repeat(15_000) + '\nMIDDLE-MARKER-783\n' + 'details '.repeat(15_000) + '\nEND-MARKER-924';
    const before = new Set((await listInputs()).map(row => row.id));
    const pending = request(prompt({ tools: clientTools, messages: [{ role: 'user', content: context }] }));
    const row = await admitted(before);
    expect(row.text.length).toBeLessThan(96_000);
    expect(row.attachments).toHaveLength(1);
    expect(row.attachments![0]!.name).toMatch(/^cos-context-[a-f0-9-]{36}\.txt$/);
    expect(row.text).toContain(row.attachments![0]!.name);
    const stored = Buffer.from(await readInputAttachmentChunk(row.attachments![0]!, 0), 'base64').toString('utf8');
    expect(stored).toContain('BEGIN-MARKER-451'); expect(stored).toContain('MIDDLE-MARKER-783'); expect(stored).toContain('END-MARKER-924');
    expect(stored).toContain('read_file');
    await answer(row.id, toolEnvelope(row.text, 'large context read'));
    expect((await (await pending).json()).choices[0].message.content).toBe('large context read');
  } finally { delete process.env.COS_OPENAI_API_TIMEOUT_MS; }
});

it('returns a clear 413 for bodies over 8 MiB without creating an input', async () => {
  const before = (await listInputs()).length;
  const response = await request(prompt({ messages: [{ role: 'user', content: 'x'.repeat(8 * 1024 * 1024) }] }));
  expect(response.status).toBe(413);
  expect((await response.json()).error.message).toContain('8 MiB');
  expect((await listInputs()).length).toBe(before);
});

it('accepts a token-bound native final after a file upload even when ChatGPT recorded no generation events', async () => {
  process.env.COS_OPENAI_API_TIMEOUT_MS = '1500';
  try {
    const before = new Set((await listInputs()).map(row => row.id));
    const pending = request(prompt({ messages: [{ role: 'user', content: 'context '.repeat(15_000) }] }));
    const row = await admitted(before);
    await createSession({ reservedId: row.id });
    const base = { source: 'extension' as const, time: Date.now() };
    await appendEvent(row.id, { ...base, kind: 'user_message', messageId: 'file-question', inputId: row.id, message: { text: row.text, chars: row.text.length, truncated: false } });
    const text = toolEnvelope(row.text, 'verified large-context answer');
    await appendEvent(row.id, { ...base, kind: 'assistant_message', messageId: 'file-answer', final: true, state: 'final', message: { text, chars: text.length, truncated: false } });
    const response = await pending;
    expect(response.status).toBe(200);
    expect((await response.json()).choices[0].message.content).toBe('verified large-context answer');
  } finally { delete process.env.COS_OPENAI_API_TIMEOUT_MS; }
});

it('never assigns a token-bound native final to a different question in the same chat', async () => {
  process.env.COS_OPENAI_API_TIMEOUT_MS = '500';
  try {
    const before = new Set((await listInputs()).map(row => row.id));
    const pending = request(prompt({ tools: clientTools }));
    const row = await admitted(before);
    await createSession({ reservedId: row.id });
    const base = { source: 'extension' as const, time: Date.now() };
    await appendEvent(row.id, { ...base, kind: 'user_message', messageId: 'owned-question', inputId: row.id, message: { text: 'request', chars: 7, truncated: false } });
    await appendEvent(row.id, { ...base, kind: 'user_message', messageId: 'different-question', inputId: 'other-input', message: { text: 'another request', chars: 15, truncated: false } });
    const text = toolEnvelope(row.text, 'must not be returned');
    await appendEvent(row.id, { ...base, kind: 'assistant_message', messageId: 'unowned-final', final: true, state: 'final', message: { text, chars: text.length, truncated: false } });
    const response = await pending;
    expect(response.status).toBe(504);
    expect(await response.json()).not.toHaveProperty('choices');
  } finally { delete process.env.COS_OPENAI_API_TIMEOUT_MS; }
});

it('accounts for mandatory CoS framing before deciding that a conversation fits inline', async () => {
  process.env.COS_OPENAI_API_TIMEOUT_MS = '2000';
  try {
    const before = new Set((await listInputs()).map(row => row.id));
    const pending = request(prompt({ messages: [{ role: 'user', content: 'x'.repeat(90_000) }] }));
    const row = await admitted(before);
    expect(row.attachments).toHaveLength(1);
    await answer(row.id, toolEnvelope(row.text, 'framing accounted for'));
    expect((await pending).status).toBe(200);
  } finally { delete process.env.COS_OPENAI_API_TIMEOUT_MS; }
});

it('records each admitted API input so a process crash cannot silently replay it after restart', async () => {
  process.env.COS_OPENAI_API_TIMEOUT_MS = '1000';
  const before = new Set((await listInputs()).map(row => row.id));
  const pending = request(prompt());
  try {
    const row = await admitted(before);
    const marker = path.join(dir, 'openai-api', 'pending-' + row.id);
    const exists = await fs.stat(marker).then(() => true, () => false);
    await answer(row.id, 'ownership recorded');
    await (await pending).json();
    expect(exists).toBe(true);
    await vi.waitFor(async () => expect(await fs.stat(marker).then(() => true, () => false)).toBe(false));
  } finally { delete process.env.COS_OPENAI_API_TIMEOUT_MS; }
});

it('withdraws abandoned API openings at startup while preserving an unrelated desktop input', async () => {
  await api.stopControlApi();
  const input = { sessionId: null, text: 'isolated startup recovery fixture', mode: 'auto' as const, dueAt: Date.now(), model: null, reasoningEffort: null };
  const owned = await sendDesktopInput({ ...input, id: randomUUID() }, false);
  const unrelated = await sendDesktopInput({ ...input, id: randomUUID() }, false);
  await fs.writeFile(path.join(dir, 'openai-api', 'pending-' + owned.id), '', { mode: 0o600 });
  await api.startControlApi();
  port = JSON.parse(await fs.readFile(path.join(dir, 'openai-api', 'endpoint.json'), 'utf8')).port;
  expect((await listInputs()).find(row => row.id === owned.id)?.state).toBe('cancelled');
  expect((await listInputs()).find(row => row.id === unrelated.id)?.state).toBe('queued');
  await cancelDesktopInput(unrelated.id);
});

it('allows native discovery to use one clean helper page instead of waiting on a protected draft', async () => {
  const restore = modelPolicy([{ id: 'gpt-6', label: 'GPT-6', efforts: ['xhigh'] }]);
  vi.mocked(chatModels.requestChatModels).mockImplementation(() => chatModels.getChatModels());
  try {
    const before = new Set((await listInputs()).map(row => row.id));
    const pending = request(prompt());
    const row = await admitted(before);
    await answer(row.id, 'discovery completed', false, 'completed', { model: 'gpt-6', reasoningEffort: 'xhigh' });
    expect((await pending).status).toBe(200);
    expect(chatModels.requestChatModels).toHaveBeenCalledWith(true);
  } finally { restore(); }
});

it('preserves long harness histories beyond 256 messages and empty assistant tool-call arrays', async () => {
  process.env.COS_OPENAI_API_TIMEOUT_MS = '2000';
  try {
    const messages = Array.from({ length: 400 }, (_, i) => i % 2 === 0
      ? { role: 'user', content: `history-item-${i}` }
      : { role: 'assistant', content: `history-item-${i}`, tool_calls: [] });
    const before = new Set((await listInputs()).map(row => row.id));
    const pending = request(prompt({ messages }));
    const row = await admitted(before);
    expect(row.text).toContain('history-item-0'); expect(row.text).toContain('history-item-399');
    await answer(row.id, 'full history preserved');
    expect((await pending).status).toBe(200);
  } finally { delete process.env.COS_OPENAI_API_TIMEOUT_MS; }
});

it('preserves namespaced tool history and object arguments normalized by a gateway', async () => {
  process.env.COS_OPENAI_API_TIMEOUT_MS = '2000';
  try {
    const before = new Set((await listInputs()).map(row => row.id));
    const pending = request(prompt({ messages: [
      { role: 'user', content: 'Read a file' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'past-call', type: 'function', function: { name: 'functions.read', arguments: { path: 'example.py' } } }] },
      { role: 'tool', tool_call_id: 'past-call', content: 'file contents' },
      { role: 'assistant', content: null },
      { role: 'user', content: 'Explain the result' }
    ] }));
    const row = await admitted(before);
    expect(row.text).toContain('functions.read'); expect(row.text).toContain('example.py');
    await answer(row.id, 'valid history');
    expect((await pending).status).toBe(200);
  } finally { delete process.env.COS_OPENAI_API_TIMEOUT_MS; }
});

it('identifies an invalid message field without including its text or argument values', async () => {
  const response = await request(prompt({ messages: [{ role: 'assistant', content: null,
    tool_calls: [{ id: 'call-invalid', type: 'function', function: { name: 'read', arguments: 42 } }] }] }));
  expect(response.status).toBe(400);
  expect((await response.json()).error.message).toContain('messages.0.tool_calls.0.function.arguments');
});
