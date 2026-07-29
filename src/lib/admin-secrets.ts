import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import type { OcxConfig } from "../types";

export const ADMIN_TOKEN_FILE = "admin-api-token";
export const SERVICE_ADMIN_TOKEN_FILE = "service-admin-token";
const activeAdminTokens = new WeakMap<OcxConfig, string>();

export function activeAdminToken(config: OcxConfig): string | undefined {
  return activeAdminTokens.get(config);
}

export function registerActiveAdminToken(config: OcxConfig, token: string): void {
  activeAdminTokens.set(config, token);
}

export function clearActiveAdminToken(config: OcxConfig): void {
  activeAdminTokens.delete(config);
}

export function adminApiTokenFilePath(configDir = getConfigDir()): string {
  return join(configDir, ADMIN_TOKEN_FILE);
}

export function serviceAdminTokenFilePath(configDir = getConfigDir()): string {
  return join(configDir, SERVICE_ADMIN_TOKEN_FILE);
}

export function loadAdminTokenFromFile(configDir = getConfigDir()): string | null {
  const path = adminApiTokenFilePath(configDir);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512) return null;
    const token = readFileSync(path, "utf8").trim();
    return /^ocx_admin_[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

export function loadServiceAdminTokenFromFile(
  env: Record<string, string | undefined> = process.env,
  configDir = getConfigDir(),
): string | null {
  if (env.OPENCODEX_ADMIN_AUTH_TOKEN?.trim()) return null;
  const path = env.OCX_ADMIN_TOKEN_FILE?.trim() || serviceAdminTokenFilePath(configDir);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512) return null;
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function configuredAdminToken(configDir = getConfigDir(), env: NodeJS.ProcessEnv = process.env): string | null {
  return env.OPENCODEX_ADMIN_AUTH_TOKEN?.trim()
    || loadAdminTokenFromFile(configDir)
    || loadServiceAdminTokenFromFile(env, configDir);
}
