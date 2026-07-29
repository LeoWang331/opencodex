import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applyProxyEnv } from "../src/config";
import { PROXY_ENV_KEYS } from "../src/lib/proxy-env";
import type { OcxConfig } from "../src/types";

const PROXY_ENV_CASED_KEYS = [
  ...PROXY_ENV_KEYS.flatMap(key => [key, key.toLowerCase()]),
  "OCX_TEST_PROXY_REF",
] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of PROXY_ENV_CASED_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of PROXY_ENV_CASED_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function configWithProxy(proxy?: string): OcxConfig {
  return { proxy, providers: {} } as unknown as OcxConfig;
}

describe("applyProxyEnv", () => {
  test("no-op when config.proxy is unset", () => {
    applyProxyEnv(configWithProxy(undefined));
    expect(process.env.HTTP_PROXY).toBeUndefined();
    expect(process.env.HTTPS_PROXY).toBeUndefined();
    expect(process.env.NO_PROXY).toBeUndefined();
  });

  test("adds loopback exclusions when the proxy comes only from the environment", () => {
    process.env.HTTPS_PROXY = "http://environment-proxy:3128";

    applyProxyEnv(configWithProxy(undefined));

    expect(process.env.HTTPS_PROXY).toBe("http://environment-proxy:3128");
    expect(process.env.HTTP_PROXY).toBeUndefined();
    expect(process.env.NO_PROXY).toBe("localhost,127.0.0.1,::1,[::1]");
  });

  test("does not treat unsupported ALL_PROXY as an active Bun proxy", () => {
    const env: Record<string, string | undefined> = {
      ALL_PROXY: "http://environment-proxy:3128",
    };

    applyProxyEnv(configWithProxy(undefined), env);

    expect(env.ALL_PROXY).toBe("http://environment-proxy:3128");
    expect(env.NO_PROXY).toBeUndefined();
    expect(env.no_proxy).toBeUndefined();
  });

  test("mirrors config.proxy into HTTP(S)_PROXY and excludes loopback (IPv4 + IPv6)", () => {
    applyProxyEnv(configWithProxy("http://proxy.corp:8080"));
    expect(process.env.HTTP_PROXY).toBe("http://proxy.corp:8080");
    expect(process.env.HTTPS_PROXY).toBe("http://proxy.corp:8080");
    expect(process.env.NO_PROXY).toBe("localhost,127.0.0.1,::1,[::1]");
  });

  test("writes config.proxy to lowercase keys when empty lowercase values shadow uppercase", () => {
    const env: Record<string, string | undefined> = {
      http_proxy: "",
      https_proxy: "",
    };
    applyProxyEnv(configWithProxy("http://proxy.corp:8080"), env);

    expect(env.http_proxy).toBe("http://proxy.corp:8080");
    expect(env.https_proxy).toBe("http://proxy.corp:8080");
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
  });

  test("user-set env vars win over config", () => {
    process.env.HTTPS_PROXY = "http://user-proxy:3128";
    applyProxyEnv(configWithProxy("http://proxy.corp:8080"));
    expect(process.env.HTTPS_PROXY).toBe("http://user-proxy:3128");
    expect(process.env.HTTP_PROXY).toBe("http://proxy.corp:8080");
  });

  test("appends loopback entries to an existing NO_PROXY without duplicating", () => {
    process.env.NO_PROXY = "internal.corp,localhost";
    applyProxyEnv(configWithProxy("http://proxy.corp:8080"));
    expect(process.env.NO_PROXY).toBe("internal.corp,localhost,127.0.0.1,::1,[::1]");
  });

  test("appends loopback entries to the lowercase no_proxy selected by Bun", () => {
    const env: Record<string, string | undefined> = {
      HTTP_PROXY: "http://environment-proxy:3128",
      NO_PROXY: "upper.example",
      no_proxy: "lower.example",
    };

    applyProxyEnv(configWithProxy(undefined), env);

    expect(env.NO_PROXY).toBe("upper.example");
    expect(env.no_proxy).toBe("lower.example,localhost,127.0.0.1,::1,[::1]");
  });

  test("dedup is case-insensitive against existing entries", () => {
    process.env.NO_PROXY = "LOCALHOST,[::1]";
    applyProxyEnv(configWithProxy("http://proxy.corp:8080"));
    expect(process.env.NO_PROXY).toBe("LOCALHOST,[::1],127.0.0.1,::1");
  });

  test("resolves ${VAR}-style env references like other config secrets", () => {
    process.env.OCX_TEST_PROXY_REF = "http://ref-proxy:9999";
    applyProxyEnv(configWithProxy("${OCX_TEST_PROXY_REF}"));
    expect(process.env.HTTP_PROXY).toBe("http://ref-proxy:9999");
  });
});
