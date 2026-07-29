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

function selectedNonBlankProxyEnv(
  key: Exclude<ProxyEnvKey, "NO_PROXY">,
  env: ProxyEnvMap,
): SelectedProxyEnv | undefined {
  const lowercaseKey = key.toLowerCase();
  const lowercaseValue = env[lowercaseKey];
  if (lowercaseValue?.trim()) return { key: lowercaseKey, value: lowercaseValue };
  const uppercaseValue = env[key];
  return uppercaseValue?.trim() ? { key, value: uppercaseValue } : undefined;
}

export function proxyEnvPresent(
  key: ProxyEnvKey,
  env: ProxyEnvMap = process.env,
): boolean {
  const selected = key === "NO_PROXY"
    ? selectedProxyEnv(key, env)
    : selectedNonBlankProxyEnv(key, env);
  return Boolean(selected?.value.trim());
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
  return selectedNonBlankProxyEnv(key, env);
}

export function outboundProxyConfigured(
  env: ProxyEnvMap = process.env,
): boolean {
  return BUN_OUTBOUND_PROXY_ENV_KEYS.some(key => proxyEnvPresent(key, env));
}
