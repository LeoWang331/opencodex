import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { connect, type Socket } from "node:net";
import { createServer, type InlineConfig } from "vite";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";

test("Vite development proxy preserves the browser host for management writes", async () => {
  const config = {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
    },
  } as OcxConfig;
  const backend = Bun.serve({
    port: 0,
    async fetch(request) {
      return await handleManagementAPI(request, new URL(request.url), config) ?? new Response(null, { status: 404 });
    },
  });
  const previousTarget = process.env.OPENCODEX_PROXY_TARGET;
  process.env.OPENCODEX_PROXY_TARGET = backend.url.toString();
  let developmentServer: Awaited<ReturnType<typeof createServer>> | null = null;
  try {
    const loaded = await import(`../vite.config.ts?management-proxy-test=${Date.now()}`) as { default: InlineConfig };
    developmentServer = await createServer({
      ...loaded.default,
      configFile: false,
      logLevel: "silent",
      server: {
        ...loaded.default.server,
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
      },
    });
    await developmentServer.listen();
    const address = developmentServer.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Vite test server did not expose a TCP port");
    const frontendOrigin = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${frontendOrigin}/api/providers/test?name=openai`, {
      method: "POST",
      headers: { origin: frontendOrigin },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({ ok: true }));
  } finally {
    if (developmentServer) await developmentServer.close();
    backend.stop(true);
    if (previousTarget === undefined) delete process.env.OPENCODEX_PROXY_TARGET;
    else process.env.OPENCODEX_PROXY_TARGET = previousTarget;
  }
}, 10_000);

async function expectReturnedDataEndpointToBeReachable(hostname: string | undefined): Promise<void> {
  const dataKey = "ocx_data_proxy_test";
  const config = {
    port: 0,
    ...(hostname === undefined ? {} : { hostname }),
    defaultProvider: "openai",
    apiKeys: [{
      id: "proxy-test-key",
      name: "proxy test",
      key: dataKey,
      createdAt: "2026-07-29T00:00:00.000Z",
    }],
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
    },
  } as OcxConfig;
  let dataRequests = 0;
  const backend = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/v1/models") {
        dataRequests += 1;
        if (request.headers.get("x-opencodex-api-key") !== dataKey) {
          return new Response("unauthorized", { status: 401 });
        }
        return Response.json({
          object: "list",
          data: [{ id: "proxy-model", object: "model", created: 0, owned_by: "proxy-test" }],
        });
      }
      return await handleManagementAPI(request, url, config) ?? new Response(null, { status: 404 });
    },
  });
  const previousTarget = process.env.OPENCODEX_PROXY_TARGET;
  process.env.OPENCODEX_PROXY_TARGET = backend.url.toString();
  let developmentServer: Awaited<ReturnType<typeof createServer>> | null = null;
  try {
    const loaded = await import(
      `../vite.config.ts?data-proxy-test=${encodeURIComponent(hostname ?? "default")}-${Date.now()}`
    ) as { default: InlineConfig };
    developmentServer = await createServer({
      ...loaded.default,
      configFile: false,
      logLevel: "silent",
      server: {
        ...loaded.default.server,
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
      },
    });
    await developmentServer.listen();
    const address = developmentServer.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Vite test server did not expose a TCP port");
    const frontendOrigin = `http://127.0.0.1:${address.port}`;

    const keysResponse = await fetch(`${frontendOrigin}/api/keys`, {
      headers: { origin: frontendOrigin },
    });
    expect(keysResponse.status).toBe(200);
    const endpoints = await keysResponse.json() as { modelsEndpoint?: string };
    expect(endpoints.modelsEndpoint).toBe(`${frontendOrigin}/v1/models`);

    const modelsResponse = await fetch(endpoints.modelsEndpoint!, {
      headers: { "x-opencodex-api-key": dataKey },
    });
    expect(modelsResponse.status).toBe(200);
    expect(await modelsResponse.json()).toEqual({
      object: "list",
      data: [{ id: "proxy-model", object: "model", created: 0, owned_by: "proxy-test" }],
    });
    expect(dataRequests).toBe(1);
  } finally {
    if (developmentServer) await developmentServer.close();
    backend.stop(true);
    if (previousTarget === undefined) delete process.env.OPENCODEX_PROXY_TARGET;
    else process.env.OPENCODEX_PROXY_TARGET = previousTarget;
  }
}

test("Vite development proxy exposes the default-host data endpoint returned by API keys", async () => {
  await expectReturnedDataEndpointToBeReachable(undefined);
});

test("Vite development proxy exposes the wildcard-host data endpoint returned by API keys", async () => {
  await expectReturnedDataEndpointToBeReachable("0.0.0.0");
});

test("Vite development proxy forwards data WebSocket upgrades to the backend", async () => {
  let backendUpgrades = 0;
  let resolveBackendUpgrade: (() => void) | undefined;
  const backendUpgradeReceived = new Promise<void>((resolve) => {
    resolveBackendUpgrade = resolve;
  });
  let backendSocket: { destroy(): void } | null = null;
  const backend = createHttpServer((_request, response) => {
    response.writeHead(404).end();
  });
  backend.on("upgrade", (request, upgradedSocket) => {
    if (request.url !== "/v1/realtime") {
      upgradedSocket.destroy();
      return;
    }
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      upgradedSocket.destroy();
      return;
    }
    backendUpgrades += 1;
    resolveBackendUpgrade?.();
    backendSocket = upgradedSocket;
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    upgradedSocket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Connection: Upgrade",
      "Upgrade: websocket",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"));
    const payload = Buffer.from("backend-ready");
    upgradedSocket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    backend.once("error", onError);
    backend.listen(0, "127.0.0.1", () => {
      backend.off("error", onError);
      resolve();
    });
  });
  const backendAddress = backend.address();
  if (!backendAddress || typeof backendAddress === "string") {
    throw new Error("WebSocket backend did not expose a TCP port");
  }
  const previousTarget = process.env.OPENCODEX_PROXY_TARGET;
  process.env.OPENCODEX_PROXY_TARGET = `http://127.0.0.1:${backendAddress.port}`;
  let developmentServer: Awaited<ReturnType<typeof createServer>> | null = null;
  let socket: Socket | null = null;
  try {
    const loaded = await import(
      `../vite.config.ts?data-websocket-proxy-test=${Date.now()}`
    ) as { default: InlineConfig };
    developmentServer = await createServer({
      ...loaded.default,
      configFile: false,
      logLevel: "silent",
      server: {
        ...loaded.default.server,
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
      },
    });
    await developmentServer.listen();
    const address = developmentServer.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Vite test server did not expose a TCP port");

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(
          `Timed out waiting for proxied WebSocket upgrade; backend upgrades: ${backendUpgrades}`,
        )),
        2_000,
      );
      socket = connect({ host: "127.0.0.1", port: address.port }, () => {
        socket?.write([
          "GET /v1/realtime HTTP/1.1",
          `Host: 127.0.0.1:${address.port}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"));
      });
      backendUpgradeReceived.then(() => {
        clearTimeout(timeout);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    expect(backendUpgrades).toBe(1);
  } finally {
    socket?.destroy();
    backendSocket?.destroy();
    if (developmentServer) await developmentServer.close();
    await new Promise<void>((resolve, reject) => {
      backend.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (previousTarget === undefined) delete process.env.OPENCODEX_PROXY_TARGET;
    else process.env.OPENCODEX_PROXY_TARGET = previousTarget;
  }
});
