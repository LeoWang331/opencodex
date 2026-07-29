import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { clearCodexUpstreamHealth } from "../src/codex/routing";
import { handleManagementAPI } from "../src/server/management-api";
import { MODEL_PROBE_TIMEOUT_MS } from "../src/server/management/model-routes";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

function providerFetchStub(handler: () => Response | Promise<Response>): typeof fetch {
  return Object.assign(async () => handler(), {
    preconnect: () => undefined,
  });
}

function directOpenAiConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
  } as OcxConfig;
}

test("management model catalog marks OpenAI Direct models as unavailable for management probes", async () => {
  const config = directOpenAiConfig();
  const url = new URL("http://127.0.0.1/api/models");
  const response = await handleManagementAPI(new Request(url, {
    headers: { host: "127.0.0.1" },
  }), url, config);
  expect(response?.status).toBe(200);
  const models = await response!.json() as Array<{ native?: boolean; managementTestable?: boolean }>;
  const nativeModels = models.filter(model => model.native === true);
  expect(nativeModels.length).toBeGreaterThan(0);
  expect(nativeModels.every(model => model.managementTestable === false)).toBe(true);
});

test("management model catalog marks routed and custom OpenAI Direct models as unavailable for management probes", async () => {
  const config = directOpenAiConfig();
  config.providers.openai!.authMode = "key";
  config.providers.openai!.apiKey = "provider-key";
  config.providers.openai!.baseUrl = "https://provider.example.test/v1";
  config.providers.openai!.liveModels = false;
  config.providers.openai!.models = ["routed-direct"];
  config.customModels = [{
    id: "custom-direct-id",
    provider: "openai",
    modelId: "custom-direct",
    displayName: "Custom Direct",
    addedAt: "2026-07-29T00:00:00.000Z",
  }];
  const url = new URL("http://127.0.0.1/api/models");
  const response = await handleManagementAPI(new Request(url, {
    headers: { host: "127.0.0.1" },
  }), url, config);
  expect(response?.status).toBe(200);
  const models = await response!.json() as Array<{
    namespaced?: string;
    custom?: boolean;
    managementTestable?: boolean;
  }>;
  expect(models.find(model => model.namespaced === "openai/routed-direct")).toMatchObject({
    managementTestable: false,
  });
  expect(models.find(model => model.namespaced === "openai/custom-direct" && model.custom === true)).toMatchObject({
    managementTestable: false,
  });
});

test("management model catalog only marks a combo testable when every selectable target is testable", async () => {
  const config = directOpenAiConfig();
  config.providers.openai = {
    ...config.providers.openai!,
    authMode: "key",
    apiKey: "provider-key",
    baseUrl: "https://provider.example.test/v1",
    liveModels: false,
    models: ["routed-direct"],
    contextWindow: 128_000,
  };
  config.providers.safe = {
    adapter: "openai-chat",
    baseUrl: "https://safe.example.test/v1",
    apiKey: "safe-key",
    liveModels: false,
    models: ["safe-model"],
    contextWindow: 128_000,
  };
  config.combos = {
    direct: {
      targets: [{ provider: "openai", model: "routed-direct" }],
    },
    mixed: {
      targets: [
        { provider: "openai", model: "routed-direct" },
        { provider: "safe", model: "safe-model" },
      ],
    },
    safe: {
      targets: [{ provider: "safe", model: "safe-model" }],
    },
    unresolved: {
      targets: [
        { provider: "safe", model: "safe-model" },
        { provider: "missing", model: "unknown-model" },
      ],
    },
  };
  const url = new URL("http://127.0.0.1/api/models");
  const response = await handleManagementAPI(new Request(url, {
    headers: { host: "127.0.0.1" },
  }), url, config);
  expect(response?.status).toBe(200);
  const models = await response!.json() as Array<{
    provider?: string;
    id?: string;
    managementTestable?: boolean;
  }>;
  const combo = (id: string) => models.find(model => model.provider === "combo" && model.id === id);
  expect(combo("direct")).toMatchObject({ managementTestable: false });
  expect(combo("mixed")).toMatchObject({ managementTestable: false });
  expect(combo("safe")).toMatchObject({ managementTestable: true });
  expect(combo("unresolved")?.managementTestable).not.toBe(true);
});

test("management model probe blocks a resolved unsafe physical route before upstream dispatch", async () => {
  let upstreamCalls = 0;
  const config = {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "mock",
    providers: {
      mock: {
        adapter: "openai-chat",
        baseUrl: "https://rebind.example.test/v1",
        apiKey: "provider-secret",
        liveModels: false,
        models: ["model-one"],
        fetch: providerFetchStub(async () => {
          upstreamCalls += 1;
          return Response.json({ error: "must not be reached" }, { status: 500 });
        }),
      },
    },
  } as OcxConfig;
  const checked: string[] = [];
  const url = new URL("http://127.0.0.1/api/models/test");

  const response = await handleManagementAPI(new Request(url, {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ model: "mock/model-one" }),
  }), url, config, {
    providerDestinationResolvedError: async name => {
      checked.push(name);
      return "baseUrl resolves to a private network address";
    },
  });

  expect(response?.status).toBe(400);
  expect(await response!.json()).toEqual({
    ok: false,
    error: "provider mock baseUrl resolves to a private network address",
  });
  expect(checked).toEqual(["mock"]);
  expect(upstreamCalls).toBe(0);
});

test("management model probe validates every selectable combo destination before dispatch", async () => {
  let upstreamCalls = 0;
  const provider = (baseUrl: string): OcxProviderConfig & { fetch: typeof fetch } => ({
    adapter: "openai-chat",
    baseUrl,
    apiKey: "provider-secret",
    liveModels: false,
    models: ["model-one"],
    fetch: providerFetchStub(async () => {
      upstreamCalls += 1;
      return Response.json({ error: "must not be reached" }, { status: 500 });
    }),
  });
  const config = {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "safe",
    providers: {
      safe: provider("https://safe.example.test/v1"),
      blocked: provider("https://rebind.example.test/v1"),
    },
    combos: {
      guarded: {
        targets: [
          { provider: "safe", model: "model-one" },
          { provider: "blocked", model: "model-one" },
        ],
      },
    },
  } as OcxConfig;
  const checked: string[] = [];
  const url = new URL("http://127.0.0.1/api/models/test");

  const response = await handleManagementAPI(new Request(url, {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ model: "combo/guarded" }),
  }), url, config, {
    providerDestinationResolvedError: async name => {
      checked.push(name);
      return name === "blocked" ? "baseUrl resolves to a private network address" : null;
    },
  });

  expect(response?.status).toBe(400);
  expect(checked).toEqual(["safe", "blocked"]);
  expect(upstreamCalls).toBe(0);
});

test("management model catalog fails closed for missing or disabled providers across model types", async () => {
  let upstreamCalls = 0;
  const config = directOpenAiConfig();
  config.providers.openai = {
    ...config.providers.openai!,
    disabled: true,
    authMode: "key",
    apiKey: "provider-key",
    baseUrl: "https://provider.example.test/v1",
    liveModels: false,
    models: ["disabled-routed"],
    fetch: (async () => {
      upstreamCalls += 1;
      return Response.json({ error: "must not be reached" }, { status: 500 });
    }) as typeof fetch,
  };
  config.customModels = [
    {
      id: "disabled-custom-id",
      provider: "openai",
      modelId: "disabled-custom",
      addedAt: "2026-07-29T00:00:00.000Z",
    },
    {
      id: "missing-custom-id",
      provider: "missing",
      modelId: "missing-custom",
      addedAt: "2026-07-29T00:00:00.000Z",
    },
  ];
  config.combos = {
    disabled: {
      targets: [{ provider: "openai", model: "disabled-routed" }],
    },
    missing: {
      targets: [{ provider: "missing", model: "missing-routed" }],
    },
  };

  const url = new URL("http://127.0.0.1/api/models");
  const response = await handleManagementAPI(new Request(url, {
    headers: { host: "127.0.0.1" },
  }), url, config);

  expect(response?.status).toBe(200);
  const models = await response!.json() as Array<{
    namespaced?: string;
    native?: boolean;
    managementTestable?: boolean;
  }>;
  const bySlug = (slug: string) => models.find(model => model.namespaced === slug);
  expect(models.filter(model => model.native === true).every(model => model.managementTestable === false)).toBe(true);
  expect(bySlug("openai/disabled-custom")).toMatchObject({ managementTestable: false });
  expect(bySlug("missing/missing-custom")).toMatchObject({ managementTestable: false });

  const probeUrl = new URL("http://127.0.0.1/api/models/test");
  for (const model of [
    "gpt-5.4",
    "openai/disabled-routed",
    "openai/disabled-custom",
    "missing/missing-routed",
    "missing/missing-custom",
    "combo/disabled",
    "combo/missing",
  ]) {
    const probeResponse = await handleManagementAPI(new Request(probeUrl, {
      method: "POST",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ model }),
    }), probeUrl, config);
    expect(probeResponse?.status).toBe(409);
  }
  expect(upstreamCalls).toBe(0);
});

test("management model probe fails closed for a missing or disabled physical combo provider", async () => {
  let upstreamCalls = 0;
  const disabledCombo = {
    adapter: "openai-chat",
    baseUrl: "https://combo.example.test/v1",
    apiKey: "combo-key",
    disabled: true,
    fetch: (async () => {
      upstreamCalls += 1;
      return Response.json({ error: "must not be reached" }, { status: 500 });
    }) as typeof fetch,
  } satisfies OcxProviderConfig & { fetch: typeof fetch };
  const configs = [
    {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "safe",
      providers: {},
    },
    {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "combo",
      providers: { combo: disabledCombo },
    },
  ] as OcxConfig[];
  const url = new URL("http://127.0.0.1/api/models/test");

  for (const config of configs) {
    const response = await handleManagementAPI(new Request(url, {
      method: "POST",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/model-one" }),
    }), url, config);
    expect(response?.status).toBe(409);
  }
  expect(upstreamCalls).toBe(0);
});

test("management model probe rejects OpenAI Direct models before attempting a caller-less request", async () => {
  const config = directOpenAiConfig();
  const modelsUrl = new URL("http://127.0.0.1/api/models");
  const modelsResponse = await handleManagementAPI(new Request(modelsUrl, {
    headers: { host: "127.0.0.1" },
  }), modelsUrl, config);
  const models = await modelsResponse!.json() as Array<{ namespaced?: string; native?: boolean }>;
  const model = models.find(row => row.native === true)?.namespaced;
  expect(typeof model).toBe("string");

  const probeUrl = new URL("http://127.0.0.1/api/models/test");
  const response = await handleManagementAPI(new Request(probeUrl, {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ model }),
  }), probeUrl, config);
  expect(response?.status).toBe(409);
  const body = await response!.json() as { ok?: boolean; error?: string };
  expect(body.ok).toBe(false);
  expect(body.error).toContain("Direct");
});

test("management model probe rejects every unsafe or unresolved route graph before any upstream request", async () => {
  let upstreamCalls = 0;
  const safeFetch = (async () => {
    upstreamCalls += 1;
    return new Response([
      'data: {"choices":[{"index":0,"delta":{"content":"pong"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ].join(""), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const config = directOpenAiConfig();
  config.providers.openai = {
    ...config.providers.openai!,
    authMode: "key",
    apiKey: "provider-key",
    baseUrl: "https://provider.example.test/v1",
    liveModels: false,
    models: ["routed-direct"],
  };
  config.providers.safe = {
    adapter: "openai-chat",
    baseUrl: "https://safe.example.test/v1",
    apiKey: "safe-key",
    liveModels: false,
    models: ["safe-model"],
    fetch: safeFetch,
  } as OcxProviderConfig & { fetch: typeof fetch };
  config.customModels = [{
    id: "custom-direct-id",
    provider: "openai",
    modelId: "custom-direct",
    addedAt: "2026-07-29T00:00:00.000Z",
  }];
  config.combos = {
    direct: {
      targets: [{ provider: "openai", model: "routed-direct" }],
    },
    mixed: {
      targets: [
        { provider: "safe", model: "safe-model" },
        { provider: "openai", model: "routed-direct" },
      ],
    },
    unresolved: {
      targets: [
        { provider: "safe", model: "safe-model" },
        { provider: "missing", model: "unknown-model" },
      ],
    },
  };
  const url = new URL("http://127.0.0.1/api/models/test");
  for (const model of [
    "gpt-5.4",
    "openai/routed-direct",
    "openai/custom-direct",
    "combo/direct",
    "combo/mixed",
    "combo/unresolved",
  ]) {
    const response = await handleManagementAPI(new Request(url, {
      method: "POST",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ model }),
    }), url, config);
    expect(response?.status).toBe(409);
  }
  expect(upstreamCalls).toBe(0);
});

test("management model probe uses provider credentials without forwarding admission tokens", async () => {
  let upstreamAuthorization: string | null = null;
  let upstreamAdmission: string | null = null;
  let upstreamBody: Record<string, unknown> | undefined;
  const providerFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    upstreamAuthorization = request.headers.get("authorization");
    upstreamAdmission = request.headers.get("x-opencodex-api-key");
    upstreamBody = await request.clone().json() as Record<string, unknown>;
    const frames = [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "pong" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
      "data: [DONE]\n\n",
    ];
    return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;

  const provider: OcxProviderConfig & { fetch: typeof fetch } = {
    adapter: "openai-chat",
    baseUrl: "https://provider.example.test/v1",
    apiKey: "provider-secret",
    liveModels: false,
    models: ["model-one"],
    fetch: providerFetch,
  };
  const config = {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "mock",
    providers: { mock: provider },
  } as OcxConfig;
  const url = new URL("http://127.0.0.1/api/models/test");
  const response = await handleManagementAPI(new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "127.0.0.1",
      authorization: `Bearer ${["ocx_admin", "browser-secret"].join("_")}`,
      "x-opencodex-api-key": "ocx_session_browser-secret",
    },
    body: JSON.stringify({ model: "mock/model-one" }),
  }), url, config);

  expect(response).not.toBeNull();
  expect(response!.status).toBe(200);
  expect(await response!.json()).toEqual({ ok: true });
  expect(upstreamBody?.model).toBe("model-one");
  expect(upstreamBody?.max_tokens).toBe(1);
  expect(upstreamBody).not.toHaveProperty("max_output_tokens");
  expect(upstreamAuthorization).toBe("Bearer provider-secret");
  expect(upstreamAdmission).toBeNull();
});

test("management model probe preserves the Responses output limit for key providers", async () => {
  let upstreamBody: Record<string, unknown> | undefined;
  const provider = {
    adapter: "openai-responses",
    baseUrl: "https://provider.example.test/v1",
    authMode: "key",
    apiKey: "provider-secret",
    liveModels: false,
    models: ["model-one"],
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      upstreamBody = await request.clone().json() as Record<string, unknown>;
      return new Response(
        `event: response.output_text.delta\ndata: ${JSON.stringify({
          type: "response.output_text.delta",
          delta: "pong",
        })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch,
  } satisfies OcxProviderConfig & { fetch: typeof fetch };
  const config = {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "mock",
    providers: { mock: provider },
  } as OcxConfig;
  const url = new URL("http://127.0.0.1/api/models/test");
  const response = await handleManagementAPI(new Request(url, {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ model: "mock/model-one" }),
  }), url, config);

  expect(response?.status).toBe(200);
  expect(await response!.json()).toEqual({ ok: true });
  expect(upstreamBody?.model).toBe("model-one");
  expect(upstreamBody?.max_output_tokens).toBe(1);
  expect(upstreamBody).not.toHaveProperty("max_tokens");
});

test("management model probe stops a native account-pool stream after its first output delta", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "ocx-management-probe-"));
  const previousOpencodexHome = process.env.OPENCODEX_HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  const originalFetch = globalThis.fetch;
  let upstreamBody: Record<string, unknown> | undefined;
  let upstreamSignal: AbortSignal | undefined;
  let fallbackDelivered = false;
  let upstreamCancelled = false;
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    process.env.OPENCODEX_HOME = testDir;
    process.env.CODEX_HOME = testDir;
    clearCodexUpstreamHealth();
    saveCodexAccountCredential("management-pool", {
      accessToken: "pool-access-token",
      refreshToken: "pool-refresh-token",
      expiresAt: Date.now() + 300_000,
      chatgptAccountId: "management_pool_account",
    });
    const config = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "openai",
      activeCodexAccountId: "management-pool",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "pool",
        },
      },
      codexAccounts: [{
        id: "management-pool",
        email: "pool@example.test",
        isMain: false,
        chatgptAccountId: "management_pool_account",
      }],
    } as OcxConfig;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      upstreamBody = await request.clone().json() as Record<string, unknown>;
      upstreamSignal = request.signal;
      const encoder = new TextEncoder();
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(
            `event: response.output_text.delta\ndata: ${JSON.stringify({
              type: "response.output_text.delta",
              delta: "pong",
            })}\n\n`,
          ));
        },
        pull(controller) {
          return new Promise<void>(resolve => {
            const finish = () => {
              request.signal.removeEventListener("abort", onAbort);
              resolve();
            };
            const onAbort = () => {
              upstreamCancelled = true;
              if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
              finish();
            };
            request.signal.addEventListener("abort", onAbort, { once: true });
            fallbackTimer = setTimeout(() => {
              fallbackDelivered = true;
              controller.enqueue(encoder.encode(
                `event: response.completed\ndata: ${JSON.stringify({
                  type: "response.completed",
                  response: { status: "completed", output: [] },
                })}\n\n`,
              ));
              controller.close();
              finish();
            }, 150);
          });
        },
        cancel() {
          upstreamCancelled = true;
          if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
        },
      }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const url = new URL("http://127.0.0.1/api/models/test");
    const response = await handleManagementAPI(new Request(url, {
      method: "POST",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.4" }),
    }), url, config);

    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ ok: true });
    expect(upstreamBody).toBeDefined();
    expect(upstreamBody).not.toHaveProperty("max_output_tokens");
    expect(upstreamSignal?.aborted).toBe(true);
    expect(upstreamCancelled).toBe(true);
    expect(fallbackDelivered).toBe(false);
  } finally {
    if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
    globalThis.fetch = originalFetch;
    clearCodexUpstreamHealth();
    rmSync(testDir, { recursive: true, force: true });
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
});

test("management model probe maps upstream authentication failures to 502", async () => {
  const provider = {
    adapter: "openai-chat",
    baseUrl: "https://provider.example.test/v1",
    apiKey: "provider-secret",
    liveModels: false,
    models: ["model-one"],
    fetch: (async () => Response.json({
      error: { message: "provider rejected credentials", type: "authentication_error" },
    }, { status: 401 })) as typeof fetch,
  } satisfies OcxProviderConfig & { fetch: typeof fetch };
  const config = {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "mock",
    providers: { mock: provider },
  } as OcxConfig;
  const url = new URL("http://127.0.0.1/api/models/test");
  const response = await handleManagementAPI(new Request(url, {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ model: "mock/model-one" }),
  }), url, config);

  expect(response?.status).toBe(502);
  const body = await response!.json() as { ok?: boolean; error?: string };
  expect(body.ok).toBe(false);
  expect(body.error).toContain("provider rejected credentials");
});

test("management model probe propagates caller cancellation to the upstream request", async () => {
  const caller = new AbortController();
  let upstreamSignal: AbortSignal | undefined;
  let markFetchStarted!: () => void;
  const fetchStarted = new Promise<void>(resolve => { markFetchStarted = resolve; });
  const provider = {
    adapter: "openai-chat",
    baseUrl: "https://provider.example.test/v1",
    apiKey: "provider-secret",
    liveModels: false,
    models: ["model-one"],
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      upstreamSignal = request.signal;
      markFetchStarted();
      return await new Promise<Response>((resolve, reject) => {
        const fallback = setTimeout(() => {
          resolve(Response.json({ error: { message: "caller cancellation did not propagate" } }, { status: 500 }));
        }, 200);
        const onAbort = () => {
          clearTimeout(fallback);
          reject(request.signal.reason);
        };
        if (request.signal.aborted) onAbort();
        else request.signal.addEventListener("abort", onAbort, { once: true });
      });
    }) as typeof fetch,
  } satisfies OcxProviderConfig & { fetch: typeof fetch };
  const config = {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "mock",
    providers: { mock: provider },
  } as OcxConfig;
  const url = new URL("http://127.0.0.1/api/models/test");
  const pending = handleManagementAPI(new Request(url, {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ model: "mock/model-one" }),
    signal: caller.signal,
  }), url, config);

  await fetchStarted;
  caller.abort(new DOMException("caller cancelled", "AbortError"));
  const response = await pending;

  expect(response?.status).toBe(499);
  expect(await response!.json()).toEqual({ ok: false, error: "Model test cancelled" });
  expect(upstreamSignal?.aborted).toBe(true);
  expect(upstreamSignal?.reason).toBe(caller.signal.reason);
});

test("management model probe maps transport timeouts to 504", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    value: ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => (
      originalSetTimeout(handler, timeout === MODEL_PROBE_TIMEOUT_MS ? 0 : timeout, ...args)
    )) as typeof setTimeout,
  });
  const provider = {
    adapter: "openai-chat",
    baseUrl: "https://provider.example.test/v1",
    apiKey: "provider-secret",
    liveModels: false,
    models: ["model-one"],
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      await new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(request.signal.reason);
        if (request.signal.aborted) onAbort();
        else request.signal.addEventListener("abort", onAbort, { once: true });
      });
      throw new Error("unreachable");
    }) as typeof fetch,
  } satisfies OcxProviderConfig & { fetch: typeof fetch };
  const config = {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "mock",
    providers: { mock: provider },
  } as OcxConfig;
  const url = new URL("http://127.0.0.1/api/models/test");
  try {
    const response = await handleManagementAPI(new Request(url, {
      method: "POST",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/model-one" }),
    }), url, config);

    expect(response?.status).toBe(504);
    const body = await response!.json() as { ok?: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error?.toLowerCase()).toContain("timed out");
  } finally {
    Object.defineProperty(globalThis, "setTimeout", { configurable: true, value: originalSetTimeout });
  }
});

test("management model probe preserves provider rate limiting as 429", async () => {
  const provider = {
    adapter: "openai-chat",
    baseUrl: "https://provider.example.test/v1",
    apiKey: "provider-secret",
    liveModels: false,
    models: ["model-one"],
    fetch: (async () => Response.json({
      error: { message: "rate limit exceeded", type: "rate_limit_error" },
    }, { status: 429 })) as typeof fetch,
  } satisfies OcxProviderConfig & { fetch: typeof fetch };
  const config = {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "mock",
    providers: { mock: provider },
  } as OcxConfig;
  const url = new URL("http://127.0.0.1/api/models/test");
  const response = await handleManagementAPI(new Request(url, {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ model: "mock/model-one" }),
  }), url, config);

  expect(response?.status).toBe(429);
  const body = await response!.json() as { ok?: boolean; error?: string };
  expect(body.ok).toBe(false);
  expect(body.error).toContain("rate limit exceeded");
});
