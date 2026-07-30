import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { installApiAuthFetch, resetApiAuthFetchForTests } from "../src/api";
import { LanguageProvider } from "../src/i18n/provider";
import ApiKeys from "../src/pages/ApiKeys";

const originalFetch = globalThis.fetch;
let restoreGlobals: (() => void) | undefined;
let previousLanguageDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  previousLanguageDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, "language");
  Object.defineProperty(globalThis.navigator, "language", { configurable: true, value: "en-US" });
  const previous = {
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    window: Object.getOwnPropertyDescriptor(globalThis, "window"),
    localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
    sessionStorage: Object.getOwnPropertyDescriptor(globalThis, "sessionStorage"),
    actEnv: Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT"),
  };
  restoreGlobals = () => {
    for (const [key, descriptor] of [
      ["document", previous.document],
      ["window", previous.window],
      ["localStorage", previous.localStorage],
      ["sessionStorage", previous.sessionStorage],
      ["IS_REACT_ACT_ENVIRONMENT", previous.actEnv],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    if (previousLanguageDescriptor) {
      Object.defineProperty(globalThis.navigator, "language", previousLanguageDescriptor);
    } else {
      delete (globalThis.navigator as { language?: string }).language;
    }
  };
});

afterEach(() => {
  resetApiAuthFetchForTests();
  globalThis.fetch = originalFetch;
  restoreGlobals?.();
});

function installManagementAuthFetch(testWindow: Window, handler: typeof fetch): void {
  Object.defineProperty(testWindow, "fetch", { configurable: true, value: handler });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: handler });
  installApiAuthFetch();
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: testWindow.fetch });
}

const EXISTING_KEY = {
  id: "key-1",
  name: "existing-key",
  prefix: "ocx_exist",
  createdAt: "2026-01-15T12:00:00.000Z",
};

const KEYS_OK = {
  keys: [EXISTING_KEY],
  baseUrl: "http://127.0.0.1:10100/v1",
  endpoint: "http://127.0.0.1:10100/v1/responses",
  responsesEndpoint: "http://127.0.0.1:10100/v1/responses",
  chatCompletionsEndpoint: "http://127.0.0.1:10100/v1/chat/completions",
  messagesEndpoint: "http://127.0.0.1:10100/v1/messages",
  modelsEndpoint: "http://127.0.0.1:10100/v1/models",
  claudeCodeEnabled: true,
};

test("successful key create keeps last-good keys visible when follow-up refresh fails", async () => {
  const testWindow = new Window({ url: "http://localhost/" });
  const container = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(container);
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });

  let keysGets = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/api/models")) {
      return Response.json([]);
    }
    if (url.endsWith("/api/keys") && method === "GET") {
      keysGets += 1;
      if (keysGets === 1) return Response.json(KEYS_OK);
      return new Response("upstream unavailable", { status: 503 });
    }
    if (url.endsWith("/api/keys") && method === "POST") {
      return Response.json({ key: "ocx_new_secret_value_only_shown_once" });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  try {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <LanguageProvider>
          <ApiKeys apiBase="http://localhost" />
        </LanguageProvider>,
      );
    });
    await act(async () => {
      await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("existing-key");
    expect(container.textContent).toContain("ocx_exist");
    expect(container.textContent).toContain("http://127.0.0.1:10100/v1");
    expect(container.textContent).not.toContain("Could not load API keys.");

    const generate = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Generate"));
    expect(generate).toBeTruthy();

    await act(async () => {
      generate!.click();
      await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
      await Promise.resolve();
    });

    expect(keysGets).toBeGreaterThanOrEqual(2);
    expect(container.textContent).toContain("existing-key");
    expect(container.textContent).toContain("ocx_exist");
    expect(container.textContent).toContain("http://127.0.0.1:10100/v1");
    expect(container.textContent).toContain("Could not load API keys.");
    expect(container.textContent).not.toContain("No API keys yet.");
  } finally {
    await act(async () => root.unmount());
    testWindow.close();
  }
});

test("successful key delete keeps last-good keys visible when follow-up refresh fails", async () => {
  const testWindow = new Window({ url: "http://localhost/" });
  const container = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(container);
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });

  let keysGets = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/api/models")) {
      return Response.json([]);
    }
    if (url.endsWith("/api/keys") && method === "GET") {
      keysGets += 1;
      if (keysGets === 1) return Response.json(KEYS_OK);
      return Response.json({ not: "keys" }, { status: 500 });
    }
    if (url.endsWith("/api/keys") && method === "DELETE") {
      return Response.json({ ok: true });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  try {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <LanguageProvider>
          <ApiKeys apiBase="http://localhost" />
        </LanguageProvider>,
      );
    });
    await act(async () => {
      await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("existing-key");

    const keyRow = [...container.querySelectorAll<HTMLButtonElement>(".apikeys-workspace-rail-row")]
      .find((button) => button.textContent?.includes("existing-key"));
    expect(keyRow).toBeTruthy();
    await act(async () => {
      keyRow!.click();
      await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
    });

    const deleteBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Delete API key"]');
    expect(deleteBtn).toBeTruthy();
    await act(async () => {
      deleteBtn!.click();
      await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 310));
    });

    const confirmBtn = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Confirm"));
    expect(confirmBtn).toBeTruthy();
    expect(confirmBtn!.disabled).toBe(false);

    await act(async () => {
      confirmBtn!.click();
      await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
      await Promise.resolve();
    });

    expect(keysGets).toBeGreaterThanOrEqual(2);
    expect(container.textContent).toContain("existing-key");
    expect(container.textContent).toContain("ocx_exist");
    expect(container.textContent).toContain("Could not load API keys.");
  } finally {
    await act(async () => root.unmount());
    testWindow.close();
  }
});

test("loads callable model ids through the management API without touching the data plane", async () => {
  const testWindow = new Window({ url: "http://localhost/" });
  const container = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(container);
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });

  const requestedPaths: string[] = [];
  const authorizedPaths: string[] = [];
  let promptCalls = 0;
  testWindow.prompt = () => {
    promptCalls += 1;
    return "admin-token";
  };
  const rawFetch = (async (input, init) => {
    const url = new URL(String(input));
    requestedPaths.push(url.pathname);
    const token = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      .get("X-OpenCodex-API-Key");
    if (token !== "admin-token") return new Response("unauthorized", { status: 401 });
    authorizedPaths.push(url.pathname);
    if (url.pathname === "/api/keys") return Response.json(KEYS_OK);
    if (url.pathname === "/api/models") {
      return Response.json([
        {
          provider: "mock",
          id: "model-one",
          namespaced: "mock/model-one",
          displayName: "Model One",
        },
        {
          provider: "mock",
          id: "disabled-model",
          namespaced: "mock/disabled-model",
          disabled: true,
        },
        {
          provider: "openai",
          id: "gpt-direct",
          namespaced: "gpt-direct",
          native: true,
          managementTestable: false,
        },
      ]);
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  installManagementAuthFetch(testWindow, rawFetch);

  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  try {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <LanguageProvider>
          <ApiKeys apiBase="http://localhost" />
        </LanguageProvider>,
      );
    });
    await act(async () => {
      await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
    });

    expect(requestedPaths).toContain("/api/models");
    expect(requestedPaths).not.toContain("/v1/models");
    expect(authorizedPaths).toContain("/api/models");
    expect(promptCalls).toBe(1);
    expect(container.textContent).toContain("mock/model-one");
    expect(container.textContent).toContain("Model One");
    expect(container.textContent).not.toContain("mock/disabled-model");
    const directRow = [...container.querySelectorAll<HTMLTableRowElement>("tbody tr")]
      .find(row => row.textContent?.includes("gpt-direct"));
    expect(directRow).toBeTruthy();
    expect([...directRow!.querySelectorAll("button")].some(button => button.textContent === "Test")).toBe(false);
  } finally {
    await act(async () => root.unmount());
    testWindow.close();
  }
});

test("tests a model through the management API without calling a data-plane endpoint", async () => {
  const testWindow = new Window({ url: "http://localhost/" });
  const container = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(container);
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });

  const requests: Array<{ path: string; method: string; body?: unknown }> = [];
  let promptCalls = 0;
  let probeManagementToken: string | null = null;
  let failProbe = false;
  testWindow.prompt = () => {
    promptCalls += 1;
    return "admin-token";
  };
  const rawFetch = (async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const token = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      .get("X-OpenCodex-API-Key");
    if (token !== "admin-token") return new Response("unauthorized", { status: 401 });
    let body: unknown;
    if (typeof init?.body === "string") body = JSON.parse(init.body) as unknown;
    requests.push({ path: url.pathname, method, ...(body === undefined ? {} : { body }) });
    if (url.pathname === "/api/keys") return Response.json(KEYS_OK);
    if (url.pathname === "/api/models" && method === "GET") {
      return Response.json([{
        provider: "mock",
        id: "model-one",
        namespaced: "mock/model-one",
      }]);
    }
    if (url.pathname === "/api/models/test" && method === "POST") {
      probeManagementToken = token;
      return failProbe
        ? Response.json({ error: "upstream rejected the model" }, { status: 502 })
        : Response.json({ ok: true });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  installManagementAuthFetch(testWindow, rawFetch);

  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  try {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <LanguageProvider>
          <ApiKeys apiBase="http://localhost" />
        </LanguageProvider>,
      );
    });
    await act(async () => {
      await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
    });

    const testButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Test");
    expect(testButton).toBeTruthy();
    await act(async () => {
      testButton!.click();
      await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
    });

    expect(requests).toContainEqual({
      path: "/api/models/test",
      method: "POST",
      body: { model: "mock/model-one" },
    });
    expect(requests.some(request => request.path.startsWith("/v1/") && request.method === "POST")).toBe(false);
    expect(probeManagementToken).toBe("admin-token");
    expect(promptCalls).toBe(1);
    expect(container.querySelector(".api-test-note--ok")).not.toBeNull();

    failProbe = true;
    await act(async () => {
      testButton!.click();
      await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
    });
    expect(container.querySelector(".api-test-note--error")?.textContent)
      .toContain("upstream rejected the model");
  } finally {
    await act(async () => root.unmount());
    testWindow.close();
  }
});
