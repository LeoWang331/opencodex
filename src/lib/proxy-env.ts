export const BUN_OUTBOUND_PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY"] as const;
export const OUTBOUND_PROXY_ENV_KEYS = [...BUN_OUTBOUND_PROXY_ENV_KEYS, "ALL_PROXY"] as const;
export const PROXY_ENV_KEYS = [...OUTBOUND_PROXY_ENV_KEYS, "NO_PROXY"] as const;

export type ProxyEnvKey = typeof PROXY_ENV_KEYS[number];
export type ProxyEnvMap = Record<string, string | undefined>;
export type SelectedProxyEnv = {
  key: string;
  value: string;
};

export function selectedProxyEnv(
  key: ProxyEnvKey,
  env: ProxyEnvMap = process.env,
): SelectedProxyEnv | undefined {
  const lowercaseKey = key.toLowerCase();
  const lowercaseValue = env[lowercaseKey];
  if (lowercaseValue !== undefined) {
    return { key: lowercaseKey, value: lowercaseValue };
  }
  const uppercaseValue = env[key];
  return uppercaseValue === undefined ? undefined : { key, value: uppercaseValue };
}

export function proxyEnvPresent(
  key: ProxyEnvKey,
  env: ProxyEnvMap = process.env,
): boolean {
  return Boolean(selectedProxyEnv(key, env)?.value.trim());
}

export function bunProxyForUrl(
  url: URL,
  env: ProxyEnvMap = process.env,
): SelectedProxyEnv | undefined {
  const key = url.protocol === "http:"
    ? "HTTP_PROXY"
    : url.protocol === "https:"
      ? "HTTPS_PROXY"
      : undefined;
  if (!key) return undefined;
  const selected = selectedProxyEnv(key, env);
  return selected?.value.trim() ? selected : undefined;
}

export function outboundProxyConfigured(
  env: ProxyEnvMap = process.env,
): boolean {
  return BUN_OUTBOUND_PROXY_ENV_KEYS.some(key => proxyEnvPresent(key, env));
}
