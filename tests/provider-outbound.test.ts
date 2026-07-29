import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderOutboundDependencies } from "../src/lib/provider-outbound";
import { PROXY_ENV_KEYS } from "../src/lib/proxy-env";

const proxyKeys = PROXY_ENV_KEYS.flatMap(key => [key, key.toLowerCase()]);
const originalProxyEnv = Object.fromEntries(proxyKeys.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

afterEach(() => {
  for (const key of proxyKeys) {
    const previous = originalProxyEnv[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  globalThis.fetch = originalFetch;
});

function directDependencies(
  response: Response,
  options?: { privateNetwork?: boolean; address?: string },
): {
  dependencies: ProviderOutboundDependencies;
  captured: { address?: string; rejectUnauthorized?: boolean; authorization?: string };
} {
  const captured: { address?: string; rejectUnauthorized?: boolean; authorization?: string } = {};
  const address = options?.address ?? "93.184.216.34";
  return {
    captured,
    dependencies: {
      resolveAddresses: mock(async () => ({
        hostname: "provider.example",
        addresses: [{ address, family: 4 }],
        privateNetwork: options?.privateNetwork === true,
      })),
      pinnedGet: mock(async (_url, pinned, _signal, requestOptions) => {
        captured.address = pinned.address;
        captured.rejectUnauthorized = requestOptions?.rejectUnauthorized;
        captured.authorization = new Headers(requestOptions?.headers).get("authorization") ?? undefined;
        return response;
      }),
    },
  };
}

async function runIsolatedBun(
  script: string,
  env: Record<string, string | undefined>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("provider outbound GET transport", () => {
  test("pins direct transport when Bun has no proxy for the request protocol", async () => {
    const { providerOutboundGet } = await import("../src/lib/provider-outbound");
    const cases = [
      {
        name: "HTTP ignores HTTPS_PROXY",
        url: "http://provider.example/v1/models",
        env: { HTTPS_PROXY: "http://127.0.0.1:9" },
      },
      {
        name: "HTTPS ignores HTTP_PROXY",
        url: "https://provider.example/v1/models",
        env: { HTTP_PROXY: "http://127.0.0.1:9" },
      },
    ] as const;

    for (const routeCase of cases) {
      for (const key of proxyKeys) delete process.env[key];
      Object.assign(process.env, routeCase.env);
      const fetchMock = mock(async () => new Response("unexpected native fetch"));
      globalThis.fetch = fetchMock as typeof fetch;
      const { dependencies, captured } = directDependencies(new Response(null, { status: 204 }));

      const response = await providerOutboundGet(
        routeCase.name,
        { baseUrl: new URL(routeCase.url).origin },
        routeCase.url,
        {},
        dependencies,
      );

      expect(response.status).toBe(204);
      expect(captured.address).toBe("93.184.216.34");
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  test("fails closed when only unsupported ALL_PROXY is configured", async () => {
    for (const key of proxyKeys) delete process.env[key];
    const {
      providerOutboundGet,
      ProviderOutboundPolicyError,
    } = await import("../src/lib/provider-outbound");
    const cases = [
      {
        url: "http://provider.example/v1/models",
        env: { ALL_PROXY: "http://127.0.0.1:9" },
        expected: "set HTTP_PROXY",
      },
      {
        url: "https://provider.example/v1/models",
        env: { all_proxy: "http://127.0.0.1:9" },
        expected: "set HTTPS_PROXY",
      },
    ] as const;

    for (const routeCase of cases) {
      const direct = directDependencies(new Response(null, { status: 204 }));
      const dependencies = {
        ...direct.dependencies,
        proxyEnv: routeCase.env,
      } as ProviderOutboundDependencies & {
        proxyEnv: Record<string, string | undefined>;
      };

      let error: unknown;
      try {
        await providerOutboundGet(
          "custom",
          { baseUrl: new URL(routeCase.url).origin },
          routeCase.url,
          {},
          dependencies,
        );
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(ProviderOutboundPolicyError);
      expect((error as Error).message).toContain("ALL_PROXY is not supported");
      expect((error as Error).message).toContain(routeCase.expected);
      expect(direct.captured.address).toBeUndefined();
    }
  });

  test("uses Bun's lowercase no_proxy precedence before deciding to bypass a proxy", async () => {
    for (const key of proxyKeys) delete process.env[key];
    const fetchMock = mock(async () => new Response(null, { status: 202 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const { providerOutboundGet } = await import("../src/lib/provider-outbound");
    const direct = directDependencies(new Response(null, { status: 204 }));
    const dependencies = {
      ...direct.dependencies,
      proxyEnv: {
        HTTP_PROXY: "http://127.0.0.1:9",
        NO_PROXY: "provider.example",
        no_proxy: "other.example",
      },
    } as ProviderOutboundDependencies & {
      proxyEnv: Record<string, string | undefined>;
    };

    const response = await providerOutboundGet(
      "custom",
      { baseUrl: "http://provider.example/v1" },
      "http://provider.example/v1/models",
      {},
      dependencies,
    );

    expect(response.status).toBe(202);
    expect(direct.captured.address).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("direct HTTPS connects only to the validated address with TLS verification", async () => {
    for (const key of proxyKeys) delete process.env[key];
    const { providerOutboundGet } = await import("../src/lib/provider-outbound");
    const { dependencies, captured } = directDependencies(new Response('{"data":[]}', {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const response = await providerOutboundGet(
      "custom",
      { baseUrl: "https://provider.example/v1" },
      "https://provider.example/v1/models",
      { headers: { authorization: "Bearer test-key" } },
      dependencies,
    );

    expect(await response.json()).toEqual({ data: [] });
    expect(captured).toEqual({
      address: "93.184.216.34",
      rejectUnauthorized: true,
      authorization: "Bearer test-key",
    });
  });

  test("a public NO_PROXY destination stays on the pinned direct transport", async () => {
    for (const key of proxyKeys) delete process.env[key];
    process.env.HTTPS_PROXY = "http://127.0.0.1:9";
    process.env.NO_PROXY = "provider.example";
    const fetchMock = mock(async () => new Response("unexpected proxy transport"));
    globalThis.fetch = fetchMock as typeof fetch;
    const { providerOutboundGet } = await import("../src/lib/provider-outbound");
    const { dependencies, captured } = directDependencies(new Response('{"data":[]}', {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const response = await providerOutboundGet(
      "custom",
      { baseUrl: "https://provider.example/v1" },
      "https://provider.example/v1/models",
      {},
      dependencies,
    );

    expect(response.status).toBe(200);
    expect(captured.address).toBe("93.184.216.34");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a NO_PROXY destination keeps DNS failures fail-closed", async () => {
    for (const key of proxyKeys) delete process.env[key];
    process.env.HTTPS_PROXY = "http://127.0.0.1:9";
    process.env.NO_PROXY = "provider.example";
    const fetchMock = mock(async () => new Response("unexpected proxy transport"));
    globalThis.fetch = fetchMock as typeof fetch;
    const {
      DestinationDnsResolutionError,
    } = await import("../src/lib/destination-policy");
    const { providerOutboundGet } = await import("../src/lib/provider-outbound");
    const dependencies: ProviderOutboundDependencies = {
      resolveAddresses: mock(async () => {
        throw new DestinationDnsResolutionError("provider URL hostname provider.example could not be resolved");
      }),
      pinnedGet: mock(async () => new Response(null, { status: 200 })),
    };

    await expect(providerOutboundGet(
      "custom",
      { baseUrl: "https://provider.example/v1" },
      "https://provider.example/v1/models",
      {},
      dependencies,
    )).rejects.toBeInstanceOf(DestinationDnsResolutionError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("private providers behind a configured proxy require an explicit NO_PROXY match", async () => {
    const proxyUrl = "http://127.0.0.1:9";
    process.env.HTTPS_PROXY = proxyUrl;
    process.env.https_proxy = proxyUrl;
    process.env.NO_PROXY = "localhost,127.0.0.1,::1,[::1]";
    process.env.no_proxy = "localhost,127.0.0.1,::1,[::1]";
    const { providerOutboundGet, ProviderOutboundPolicyError } = await import("../src/lib/provider-outbound");
    const { dependencies, captured } = directDependencies(new Response(null, { status: 200 }), {
      privateNetwork: true,
      address: "192.168.1.50",
    });

    let error: unknown;
    try {
      await providerOutboundGet(
        "ollama-lan",
        { baseUrl: "https://ollama.lan:11434/v1", allowPrivateNetwork: true },
        "https://ollama.lan:11434/v1/models",
        {},
        dependencies,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ProviderOutboundPolicyError);
    expect((error as Error).message).toMatch(/add ollama\.lan to NO_PROXY/);
    expect(captured.address).toBeUndefined();
  });

  test("direct redirects return the same credential-safe final-URL guidance", async () => {
    for (const key of proxyKeys) delete process.env[key];
    const redirectTarget = new URL("https://final.example/v1/models?token=secret#fragment");
    redirectTarget.username = "user";
    redirectTarget.password = "password";
    const { providerOutboundGet, providerRedirectError } = await import("../src/lib/provider-outbound");
    const { dependencies } = directDependencies(new Response(null, {
      status: 302,
      headers: { location: redirectTarget.toString() },
    }));
    const requestUrl = "https://provider.example/v1/models";

    const response = await providerOutboundGet(
      "custom",
      { baseUrl: "https://provider.example/v1" },
      requestUrl,
      {},
      dependencies,
    );
    const error = await providerRedirectError(response, requestUrl);

    expect(error).toContain("returned 302 redirect");
    expect(error).toContain("https://final.example/v1/models");
    expect(error).not.toContain("user:password");
    expect(error).not.toContain("token=secret");
  });

  test("a per-provider fetch override remains the transport injection boundary", async () => {
    for (const key of proxyKeys) delete process.env[key];
    const override = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return new Response('{"data":[{"id":"override-model"}]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const provider = {
      baseUrl: "https://override.example/v1",
      fetch: override,
    } as { baseUrl: string; fetch: typeof fetch };
    const { providerOutboundGet } = await import("../src/lib/provider-outbound");

    const response = await providerOutboundGet(
      "override",
      provider,
      "https://override.example/v1/models",
    );

    expect(await response.json()).toEqual({ data: [{ id: "override-model" }] });
    expect(override).toHaveBeenCalledTimes(1);
  });

  test("matches Bun's real protocol, casing, and NO_PROXY routing table", async () => {
    const childEnv = { ...process.env };
    for (const key of proxyKeys) delete childEnv[key];
    const script = String.raw`
      import { createServer } from "node:http";

      const events = { A: [], B: [] };
      function proxy(label) {
        const server = createServer((request, response) => {
          events[label].push("request:" + request.method + ":" + request.url);
          response.writeHead(204);
          response.end();
        });
        server.on("connect", (request, socket) => {
          events[label].push("connect:" + request.url);
          socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        });
        return server;
      }
      function listen(server) {
        return new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => resolve(server.address().port));
        });
      }
      function close(server) {
        return new Promise(resolve => server.close(() => resolve()));
      }

      const proxyA = proxy("A");
      const proxyB = proxy("B");
      const ports = await Promise.all([listen(proxyA), listen(proxyB)]);
      const proxyAUrl = "http://127.0.0.1:" + ports[0];
      const proxyBUrl = "http://127.0.0.1:" + ports[1];
      const proxyKeys = [
        "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy",
        "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy",
      ];
      const cleanEnv = { ...process.env };
      for (const key of proxyKeys) delete cleanEnv[key];
      const cases = [
        ["HTTP uses HTTP_PROXY", "http://route-target.invalid/path", { HTTP_PROXY: proxyAUrl }],
        ["HTTP uses http_proxy", "http://route-target.invalid/path", { http_proxy: proxyAUrl }],
        ["HTTP ignores HTTPS_PROXY", "http://route-target.invalid/path", { HTTPS_PROXY: proxyAUrl }],
        ["HTTP ignores ALL_PROXY", "http://route-target.invalid/path", { ALL_PROXY: proxyAUrl }],
        ["HTTP ignores all_proxy", "http://route-target.invalid/path", { all_proxy: proxyAUrl }],
        ["HTTPS uses HTTPS_PROXY", "https://route-target.invalid/path", { HTTPS_PROXY: proxyAUrl }],
        ["HTTPS uses https_proxy", "https://route-target.invalid/path", { https_proxy: proxyAUrl }],
        ["HTTPS ignores HTTP_PROXY", "https://route-target.invalid/path", { HTTP_PROXY: proxyAUrl }],
        ["HTTPS ignores ALL_PROXY", "https://route-target.invalid/path", { ALL_PROXY: proxyAUrl }],
        ["HTTP lowercase proxy wins", "http://route-target.invalid/path", {
          HTTP_PROXY: proxyAUrl,
          http_proxy: proxyBUrl,
        }],
        ["HTTPS lowercase proxy wins", "https://route-target.invalid/path", {
          HTTPS_PROXY: proxyAUrl,
          https_proxy: proxyBUrl,
        }],
        ["lowercase no_proxy miss wins", "http://route-target.invalid/path", {
          HTTP_PROXY: proxyAUrl,
          NO_PROXY: "route-target.invalid",
          no_proxy: "other.invalid",
        }],
        ["lowercase no_proxy match wins", "http://route-target.invalid/path", {
          HTTP_PROXY: proxyAUrl,
          NO_PROXY: "other.invalid",
          no_proxy: "route-target.invalid",
        }],
        ["empty lowercase proxy disables uppercase", "http://route-target.invalid/path", {
          HTTP_PROXY: proxyAUrl,
          http_proxy: "",
        }],
      ];
      const fetchTemplate = 'const target = "URL"; try { await fetch(target, { signal: AbortSignal.timeout(2500) }); } catch {}';
      const routes = [];

      try {
        for (const [name, url, routeEnv] of cases) {
          const beforeA = events.A.length;
          const beforeB = events.B.length;
          const fetchScript = fetchTemplate.replace('"URL"', JSON.stringify(url));
          const child = Bun.spawn([process.execPath, "-e", fetchScript], {
            env: { ...cleanEnv, ...routeEnv },
            stdout: "ignore",
            stderr: "ignore",
          });
          const exitCode = await child.exited;
          await Bun.sleep(20);
          routes.push({
            name,
            route: events.A.length > beforeA ? "A" : events.B.length > beforeB ? "B" : "direct",
            exitCode,
          });
        }
      } finally {
        await Promise.all([close(proxyA), close(proxyB)]);
      }
      console.log(JSON.stringify(routes));
    `;

    const result = await runIsolatedBun(script, childEnv);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual([
      { name: "HTTP uses HTTP_PROXY", route: "A", exitCode: 0 },
      { name: "HTTP uses http_proxy", route: "A", exitCode: 0 },
      { name: "HTTP ignores HTTPS_PROXY", route: "direct", exitCode: 0 },
      { name: "HTTP ignores ALL_PROXY", route: "direct", exitCode: 0 },
      { name: "HTTP ignores all_proxy", route: "direct", exitCode: 0 },
      { name: "HTTPS uses HTTPS_PROXY", route: "A", exitCode: 0 },
      { name: "HTTPS uses https_proxy", route: "A", exitCode: 0 },
      { name: "HTTPS ignores HTTP_PROXY", route: "direct", exitCode: 0 },
      { name: "HTTPS ignores ALL_PROXY", route: "direct", exitCode: 0 },
      { name: "HTTP lowercase proxy wins", route: "B", exitCode: 0 },
      { name: "HTTPS lowercase proxy wins", route: "B", exitCode: 0 },
      { name: "lowercase no_proxy miss wins", route: "A", exitCode: 0 },
      { name: "lowercase no_proxy match wins", route: "direct", exitCode: 0 },
      { name: "empty lowercase proxy disables uppercase", route: "direct", exitCode: 0 },
    ]);
  }, 20_000);

  test("proxy mode reaches one real proxy across outbound, connection-test, and model-discovery paths", async () => {
    const childHome = mkdtempSync(join(tmpdir(), "ocx-provider-proxy-e2e-"));
    const childEnv = { ...process.env };
    for (const key of proxyKeys) delete childEnv[key];
    const script = String.raw`
      import { createServer } from "node:http";
      import { saveConfig } from "./src/config.ts";
      import { fetchProviderModels } from "./src/codex/catalog/provider-fetch.ts";
      import { providerOutboundGet } from "./src/lib/provider-outbound.ts";
      import { handleManagementAPI } from "./src/server/management-api.ts";
      import { ManagementRequest } from "./tests/helpers/management-auth.ts";

      function listen(server) {
        return new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => resolve(server.address().port));
        });
      }
      function close(server) {
        return new Promise(resolve => server.close(() => resolve()));
      }
      async function probe(config, name) {
        saveConfig(config);
        const request = new ManagementRequest(
          "http://127.0.0.1/api/providers/test?name=" + encodeURIComponent(name),
          { method: "POST" },
        );
        const response = await handleManagementAPI(request, new URL(request.url), config, {});
        if (!response) throw new Error("handler returned no response");
        return await response.json();
      }

      const proxyRequests = [];
      const providerRequests = [];
      const redirectTarget = new URL("http://final.example/v1/models?token=secret#fragment");
      redirectTarget.username = "user";
      redirectTarget.password = "password";
      const proxy = createServer((request, response) => {
        proxyRequests.push(request.url || "");
        if (request.url && request.url.startsWith("http://connection-proxy.invalid/")) {
          response.writeHead(302, { location: redirectTarget.toString() });
          response.end();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(request.url && request.url.startsWith("http://proxy-models.invalid/")
          ? '{"data":[{"id":"proxy-discovered-model"}]}'
          : '{"data":[{"id":"proxied-model"}]}');
      });
      const provider = createServer((request, response) => {
        providerRequests.push(request.url || "");
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"data":[{"id":"local-model"}]}');
      });

      try {
        const ports = await Promise.all([listen(proxy), listen(provider)]);
        const proxyUrl = "http://127.0.0.1:" + ports[0];
        const providerUrl = "http://127.0.0.1:" + ports[1] + "/v1";
        process.env.HTTP_PROXY = proxyUrl;
        process.env.http_proxy = proxyUrl;
        process.env.NO_PROXY = "localhost,127.0.0.1,::1,[::1]";
        process.env.no_proxy = "localhost,127.0.0.1,::1,[::1]";

        const outboundResponse = await providerOutboundGet(
          "proxied",
          { baseUrl: "http://proxy-only.invalid/v1", allowPrivateNetwork: false },
          "http://proxy-only.invalid/v1/models",
        );
        const outbound = {
          status: outboundResponse.status,
          body: await outboundResponse.text(),
        };
        const managementProxy = await probe({
          port: 0,
          hostname: "127.0.0.1",
          defaultProvider: "proxied",
          providers: {
            proxied: {
              adapter: "openai-chat",
              baseUrl: "http://connection-proxy.invalid/v1",
              apiKey: "sk-x",
            },
          },
        }, "proxied");
        const proxyModels = await fetchProviderModels("proxy-discovery-e2e", {
          baseUrl: "http://proxy-models.invalid/v1",
          adapter: "openai-chat",
          apiKey: "sk-test",
          models: [],
        }, 0);

        const localConfig = {
          port: 0,
          hostname: "127.0.0.1",
          defaultProvider: "local",
          providers: {
            local: {
              adapter: "openai-chat",
              baseUrl: providerUrl,
              apiKey: "sk-x",
              allowPrivateNetwork: true,
            },
          },
        };
        const managementNoProxy = await probe(localConfig, "local");
        for (const key of [
          "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy",
          "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy",
        ]) delete process.env[key];
        const managementDirect = await probe(localConfig, "local");
        const directModels = await fetchProviderModels("direct-discovery-e2e", {
          baseUrl: providerUrl,
          adapter: "openai-chat",
          apiKey: "sk-test",
          allowPrivateNetwork: true,
          models: [],
        }, 0);

        console.log(JSON.stringify({
          outbound,
          managementProxy,
          proxyModels: proxyModels.map(model => model.id),
          managementNoProxy,
          managementDirect,
          directModels: directModels.map(model => model.id),
          proxyRequests,
          providerRequests,
        }));
      } finally {
        await Promise.all([close(proxy), close(provider)]);
      }
    `;

    try {
      const isolated = await runIsolatedBun(script, {
        ...childEnv,
        OPENCODEX_HOME: childHome,
      });
      if (isolated.exitCode !== 0) {
        throw new Error(`provider outbound fixture exited ${isolated.exitCode}: ${isolated.stderr.trim()}`);
      }
      const result = JSON.parse(isolated.stdout.trim()) as {
        outbound: { status: number; body: string };
        managementProxy: Record<string, unknown>;
        proxyModels: string[];
        managementNoProxy: Record<string, unknown>;
        managementDirect: Record<string, unknown>;
        directModels: string[];
        proxyRequests: string[];
        providerRequests: string[];
      };

      expect(result.outbound).toEqual({
          status: 200,
          body: '{"data":[{"id":"proxied-model"}]}',
      });
      expect(result.managementProxy.ok).toBe(false);
      expect(String(result.managementProxy.error)).toContain("returned 302 redirect");
      expect(String(result.managementProxy.error)).toContain("http://final.example/v1/models");
      expect(String(result.managementProxy.error)).not.toContain("user:password");
      expect(String(result.managementProxy.error)).not.toContain("token=secret");
      expect(result.proxyModels).toEqual(["proxy-discovered-model"]);
      expect(result.managementNoProxy).toMatchObject({ ok: true, models: 1 });
      expect(result.managementDirect).toMatchObject({ ok: true, models: 1 });
      expect(result.directModels).toEqual(["local-model"]);
      expect(result.proxyRequests).toEqual([
        "http://proxy-only.invalid/v1/models",
        "http://connection-proxy.invalid/v1/models",
        "http://proxy-models.invalid/v1/models",
      ]);
      expect(result.providerRequests).toEqual(["/v1/models", "/v1/models", "/v1/models"]);
      expect(isolated.stderr).toContain("cannot be pinned locally");
    } finally {
      rmSync(childHome, { recursive: true, force: true });
    }
  }, 15_000);
});
