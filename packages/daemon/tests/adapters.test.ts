import { describe, expect, it, vi, afterEach } from 'vitest';

import { WebhookAdapter } from '../src/provider/adapters/webhook.js';
import { SubprocessAdapter } from '../src/provider/adapters/subprocess.js';
import { McpSamplingAdapter, type McpSamplingFn } from '../src/provider/adapters/mcp-sampling.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---------------------------------------------------------------------------
// WebhookAdapter
// ---------------------------------------------------------------------------

describe('WebhookAdapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('validates URL scheme at construction', () => {
    expect(() => new WebhookAdapter({ url: 'ftp://example.com' })).toThrow('http or https');
    expect(() => new WebhookAdapter({ url: 'not-a-url' })).toThrow('Invalid webhook URL');
  });

  it('rejects non-body methods', () => {
    expect(() => new WebhookAdapter({ url: 'https://example.com', method: 'GET' })).toThrow('POST, PUT, PATCH');
    expect(() => new WebhookAdapter({ url: 'https://example.com', method: 'DELETE' })).toThrow('POST, PUT, PATCH');
  });

  it('POSTs task input and returns response body', async () => {
    const responseBody = encoder.encode('result-data');
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(responseBody, { status: 200 }),
    );

    const adapter = new WebhookAdapter({ url: 'https://test.example.com/api' });
    const result = await adapter.execute({
      taskId: 'task-42',
      capability: 'translate',
      inputData: encoder.encode('hello'),
    });

    expect(decoder.decode(result.resultData)).toBe('result-data');

    const [url, init] = spy.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('https://test.example.com/api');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Mesh-Task-Id']).toBe('task-42');
    expect((init.headers as Record<string, string>)['X-Mesh-Capability']).toBe('translate');
    expect(init.redirect).toBe('manual');
  });

  it('sends custom headers', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    );

    const adapter = new WebhookAdapter({
      url: 'https://test.example.com/api',
      headers: { Authorization: 'Bearer tok' },
    });
    await adapter.execute({
      taskId: 't',
      capability: 'c',
      inputData: new Uint8Array(0),
    });

    const headers = (spy.mock.calls[0] as [URL, RequestInit])[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok');
  });

  it('throws on non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('bad request', { status: 400 }),
    );

    const adapter = new WebhookAdapter({ url: 'https://test.example.com/api' });
    await expect(
      adapter.execute({ taskId: 't', capability: 'c', inputData: new Uint8Array(0) }),
    ).rejects.toThrow('HTTP 400');
  });

  it('throws on redirect', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 302, headers: { Location: 'https://evil.com' } }),
    );

    const adapter = new WebhookAdapter({ url: 'https://test.example.com/api' });
    await expect(
      adapter.execute({ taskId: 't', capability: 'c', inputData: new Uint8Array(0) }),
    ).rejects.toThrow('redirect');
  });

  it('throws on timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          (init?.signal as AbortSignal)?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
    );

    const adapter = new WebhookAdapter({ url: 'https://test.example.com/api', timeoutMs: 50 });
    await expect(
      adapter.execute({ taskId: 't', capability: 'c', inputData: new Uint8Array(0) }),
    ).rejects.toThrow('timed out');
  });
});

// ---------------------------------------------------------------------------
// SubprocessAdapter
// ---------------------------------------------------------------------------

describe('SubprocessAdapter', () => {
  it('validates non-empty command at construction', () => {
    expect(() => new SubprocessAdapter({ command: '' })).toThrow('non-empty command');
    expect(() => new SubprocessAdapter({ command: '   ' })).toThrow('non-empty command');
  });

  it('runs a process and returns stdout', async () => {
    const adapter = new SubprocessAdapter({
      command: 'node',
      args: ['-e', 'process.stdin.resume(); process.stdin.on("data", d => { process.stdout.write(d.toString().toUpperCase()); process.stdin.destroy(); })'],
    });

    const result = await adapter.execute({
      taskId: 'task-1',
      capability: 'upper',
      inputData: encoder.encode('hello'),
    });

    expect(decoder.decode(result.resultData)).toBe('HELLO');
  });

  it('passes MESH_TASK_ID and MESH_CAPABILITY env vars', async () => {
    const adapter = new SubprocessAdapter({
      command: 'node',
      args: ['-e', 'process.stdout.write(JSON.stringify({ tid: process.env.MESH_TASK_ID, cap: process.env.MESH_CAPABILITY }))'],
    });

    const result = await adapter.execute({
      taskId: 'env-task',
      capability: 'env-cap',
      inputData: new Uint8Array(0),
    });

    const parsed = JSON.parse(decoder.decode(result.resultData)) as { tid: string; cap: string };
    expect(parsed.tid).toBe('env-task');
    expect(parsed.cap).toBe('env-cap');
  });

  it('passes extra env vars from config', async () => {
    const adapter = new SubprocessAdapter({
      command: 'node',
      args: ['-e', 'process.stdout.write(process.env.MY_CUSTOM_VAR ?? "missing")'],
      env: { MY_CUSTOM_VAR: 'custom-value' },
    });

    const result = await adapter.execute({
      taskId: 't',
      capability: 'c',
      inputData: new Uint8Array(0),
    });

    expect(decoder.decode(result.resultData)).toBe('custom-value');
  });

  it('throws on non-zero exit code with stderr', async () => {
    const adapter = new SubprocessAdapter({
      command: 'node',
      args: ['-e', 'process.stderr.write("something went wrong"); process.exit(1)'],
    });

    await expect(
      adapter.execute({ taskId: 't', capability: 'c', inputData: new Uint8Array(0) }),
    ).rejects.toThrow(/exited with code 1.*something went wrong/);
  });

  it('throws on timeout', async () => {
    const adapter = new SubprocessAdapter({
      command: 'node',
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      timeoutMs: 100,
    });

    await expect(
      adapter.execute({ taskId: 't', capability: 'c', inputData: new Uint8Array(0) }),
    ).rejects.toThrow('timed out');
  });

  it('throws when command does not exist', async () => {
    const adapter = new SubprocessAdapter({
      command: 'nonexistent-binary-abc123',
    });

    await expect(
      adapter.execute({ taskId: 't', capability: 'c', inputData: new Uint8Array(0) }),
    ).rejects.toThrow('failed to start');
  });
});

// ---------------------------------------------------------------------------
// McpSamplingAdapter
// ---------------------------------------------------------------------------

describe('McpSamplingAdapter', () => {
  const makeSamplingFn = (text: string, model = 'test-model'): McpSamplingFn =>
    vi.fn().mockResolvedValue({
      role: 'assistant',
      content: { type: 'text', text },
      model,
      stopReason: 'endTurn',
    });

  it('validates appName and systemPrompt at construction', () => {
    const noop = vi.fn();
    expect(
      () => new McpSamplingAdapter({ appName: '', systemPrompt: 'test' }, noop),
    ).toThrow('non-empty appName');
    expect(
      () => new McpSamplingAdapter({ appName: 'app', systemPrompt: '' }, noop),
    ).toThrow('non-empty systemPrompt');
  });

  it('sends a sampling request and returns the text', async () => {
    const sampleFn = makeSamplingFn('Bonjour');
    const adapter = new McpSamplingAdapter(
      { appName: 'claude', systemPrompt: 'Translate to French.' },
      sampleFn,
    );

    const result = await adapter.execute({
      taskId: 'task-99',
      capability: 'translate',
      inputData: encoder.encode('Hello'),
    });

    expect(decoder.decode(result.resultData)).toBe('Bonjour');
    expect(result.metadata?.model).toBe('test-model');
    expect(result.metadata?.stopReason).toBe('endTurn');

    // verify the sampling call params
    const [appName, params] = (sampleFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { messages: Array<{ role: string; content: { type: string; text: string } }>; systemPrompt: string; maxTokens: number }];
    expect(appName).toBe('claude');
    expect(params.systemPrompt).toBe('Translate to French.');
    expect(params.maxTokens).toBe(4096);
    expect(params.messages[0].role).toBe('user');
    expect(params.messages[0].content.text).toBe('Hello');
  });

  it('passes modelHint when configured', async () => {
    const sampleFn = makeSamplingFn('ok');
    const adapter = new McpSamplingAdapter(
      { appName: 'claude', systemPrompt: 'Do stuff.', modelHint: 'claude-sonnet' },
      sampleFn,
    );

    await adapter.execute({
      taskId: 't',
      capability: 'c',
      inputData: encoder.encode('input'),
    });

    const params = (sampleFn as ReturnType<typeof vi.fn>).mock.calls[0][1] as { modelPreferences?: { hints: Array<{ name: string }> } };
    expect(params.modelPreferences?.hints).toEqual([{ name: 'claude-sonnet' }]);
  });

  it('extracts text from array content blocks', async () => {
    const sampleFn: McpSamplingFn = vi.fn().mockResolvedValue({
      role: 'assistant',
      content: [
        { type: 'image', data: 'base64...', mimeType: 'image/png' },
        { type: 'text', text: 'found it' },
      ],
      model: 'm',
    });

    const adapter = new McpSamplingAdapter(
      { appName: 'app', systemPrompt: 'prompt' },
      sampleFn,
    );

    const result = await adapter.execute({
      taskId: 't',
      capability: 'c',
      inputData: encoder.encode('input'),
    });

    expect(decoder.decode(result.resultData)).toBe('found it');
  });

  it('throws when no text content in response', async () => {
    const sampleFn: McpSamplingFn = vi.fn().mockResolvedValue({
      role: 'assistant',
      content: { type: 'image', data: 'base64...', mimeType: 'image/png' },
      model: 'm',
    });

    const adapter = new McpSamplingAdapter(
      { appName: 'app', systemPrompt: 'prompt' },
      sampleFn,
    );

    await expect(
      adapter.execute({ taskId: 't', capability: 'c', inputData: encoder.encode('x') }),
    ).rejects.toThrow('no text content');
  });

  it('throws on invalid UTF-8 input', async () => {
    const sampleFn = makeSamplingFn('ok');
    const adapter = new McpSamplingAdapter(
      { appName: 'app', systemPrompt: 'prompt' },
      sampleFn,
    );

    // Invalid UTF-8 sequence
    const badUtf8 = new Uint8Array([0xff, 0xfe, 0xfd]);
    await expect(
      adapter.execute({ taskId: 't', capability: 'c', inputData: badUtf8 }),
    ).rejects.toThrow('valid UTF-8');
  });

  it('throws when sampling function rejects', async () => {
    const sampleFn: McpSamplingFn = vi.fn().mockRejectedValue(new Error('No client connected'));

    const adapter = new McpSamplingAdapter(
      { appName: 'app', systemPrompt: 'prompt' },
      sampleFn,
    );

    await expect(
      adapter.execute({ taskId: 't', capability: 'c', inputData: encoder.encode('x') }),
    ).rejects.toThrow('No client connected');
  });
});
