import { join } from "node:path";
import { readFileSync, unlinkSync } from "node:fs";
import { getConfigDir } from "../config";
import { serviceAdminTokenFilePath } from "./admin-secrets";

export function serviceApiTokenFilePath(configDir = getConfigDir()): string {
  return join(configDir, "service-api-token");
}

/**
 * App-side service token loading (WinSW native mode has no batch wrapper to read the
 * token file into the environment). Pure: returns the token or null — the CALLER
 * assigns it to process.env.OPENCODEX_API_AUTH_TOKEN. Loads only when the env token
 * is empty and OCX_API_TOKEN_FILE names a readable file.
 */
export function loadServiceTokenFromFile(env: Record<string, string | undefined>): string | null {
  if (env.OPENCODEX_API_AUTH_TOKEN?.trim()) return null;
  const file = env.OCX_API_TOKEN_FILE?.trim();
  if (!file) return null;
  try {
    const token = readFileSync(file, "utf8").trim();
    return token || null;
  } catch {
    return null;
  }
}

/**
 * Load the service-delivered data-plane credential before the server starts. The management
 * credential file is read directly by management-auth so it never enters process.env.
 */
export function loadServiceTokensIntoEnv(
  env: Record<string, string | undefined>,
  _configDir = getConfigDir(),
): void {
  const dataToken = loadServiceTokenFromFile(env);
  if (dataToken) env.OPENCODEX_API_AUTH_TOKEN = dataToken;
}

export function removeServiceTokenFiles(
  configDir = getConfigDir(),
  remove: (path: string) => void = unlinkSync,
): string[] {
  const residual: string[] = [];
  const files = [
    ["service-api-token", serviceApiTokenFilePath(configDir)],
    ["service-admin-token", serviceAdminTokenFilePath(configDir)],
  ] as const;
  for (const [name, path] of files) {
    try {
      remove(path);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as NodeJS.ErrnoException).code)
        : "";
      if (code !== "ENOENT") residual.push(name);
    }
  }
  return residual;
}
