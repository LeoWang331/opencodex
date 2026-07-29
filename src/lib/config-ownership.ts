import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  futimesSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const CONFIG_OWNER_FILE = ".opencodex-owner.json";
export const CONFIG_UNINSTALL_MANIFEST = ".opencodex-uninstall.json";

export type ConfigRemovalResult = {
  status: "absent" | "removed" | "partial" | "refused";
  reason?: string;
  residualPaths: string[];
};

export interface ConfigOwnershipLockOptions {
  lockTimeoutMs?: number;
  leaseRefreshMs?: number;
}

type ConfigOwner = {
  version: 1;
  ownerId: string;
  root: string;
};

type ConfigUninstallManifest = ConfigOwner & {
  paths: string[];
};

const METADATA_MAX_BYTES = 64 * 1024;
const MANIFEST_MAX_PATHS = 1024;
const OWNERSHIP_LOCK_FILE = ".opencodex-owner.lock";
const OWNERSHIP_RECOVERY_LOCK_FILE = ".opencodex-owner-recovery.lock";
const OWNERSHIP_RECOVERY_CLAIM_PREFIX = `${OWNERSHIP_RECOVERY_LOCK_FILE}.claim-`;
const OWNERSHIP_LOCK_PUBLISH_TEMP_PREFIX = ".opencodex-owner-lock-publish-";
const OWNERSHIP_LOCK_TIMEOUT_MS = 5_000;
const OWNERSHIP_LOCK_STALE_MS = 30_000;
const OWNERSHIP_LOCK_RETRY_MS = 10;
const OWNERSHIP_LOCK_MAX_BYTES = 256;
const INITIAL_OWNED_PATHS = [
  ".star-prompted",
  "admin-api-token",
  "artifacts",
  "auth.json",
  "auth.store.lock",
  "catalog-backup.json",
  "claude-env.sh",
  "codex-accounts.json",
  "codex-runtime-clamp.json",
  "codex-runtime.json",
  "codex-shim.autorestore.lock",
  "codex-shim.json",
  "config.json",
  "crash.log",
  "kimi-device-id",
  "mimo-client-id",
  "ocx.pid",
  "opencodex-service-launcher.vbs",
  "opencodex-service-task.xml",
  "opencodex-service.cmd",
  "opencodex-tray-offline.ico",
  "opencodex-tray-online.ico",
  "opencodex-tray-warning.ico",
  "opencodex-tray.ps1",
  "responses-state.json",
  "runtime-port.json",
  "service-admin-token",
  "service-api-token",
  "service-state.json",
  "service.log",
  "system-env-port",
  "tray-heartbeat.json",
  "tray-state.json",
  "update-job.json",
  "usage-debug.jsonl",
  "usage.jsonl",
  "version.json",
  "winsw",
] as const;
const ownershipLockWait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function readBoundedJson(path: string): unknown {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("ownership metadata is not a regular file");
  }
  if (metadata.size > METADATA_MAX_BYTES) throw new Error("ownership metadata is too large");
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function isOwner(value: unknown): value is ConfigOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as Record<string, unknown>;
  return owner.version === 1
    && typeof owner.ownerId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(owner.ownerId)
    && typeof owner.root === "string";
}

function isManifest(value: unknown): value is ConfigUninstallManifest {
  if (!isOwner(value)) return false;
  const paths = (value as Record<string, unknown>).paths;
  return Array.isArray(paths)
    && paths.length <= MANIFEST_MAX_PATHS
    && paths.every(path => typeof path === "string");
}

function canonicalRoot(configDir: string): string {
  return realpathSync.native(resolve(configDir));
}

function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (
    rel !== ".."
    && !rel.startsWith(`..${sep}`)
    && !isAbsolute(rel)
  );
}

function manifestRelativePath(configDir: string, candidatePath: string): string | null {
  const root = resolve(configDir);
  const candidate = resolve(candidatePath);
  const rel = relative(root, candidate);
  if (
    !rel
    || rel === ".."
    || rel.startsWith(`..${sep}`)
    || isAbsolute(rel)
  ) return null;
  const normalized = rel.split(sep).join("/");
  if (normalized.split("/").some(part => !part || part === "." || part === ".." || part.includes("\\"))) {
    return null;
  }
  if (
    normalized === CONFIG_OWNER_FILE
    || normalized === CONFIG_UNINSTALL_MANIFEST
    || isOwnershipInfrastructureName(normalized)
  ) return null;
  return normalized;
}

function loadOwnership(configDir: string): { owner: ConfigOwner; manifest: ConfigUninstallManifest } | null {
  const ownerPath = join(configDir, CONFIG_OWNER_FILE);
  const manifestPath = join(configDir, CONFIG_UNINSTALL_MANIFEST);
  if (!existsSync(ownerPath) || !existsSync(manifestPath)) return null;
  try {
    const owner = readBoundedJson(ownerPath);
    const manifest = readBoundedJson(manifestPath);
    const root = canonicalRoot(configDir);
    if (
      !isOwner(owner)
      || !isManifest(manifest)
      || owner.ownerId !== manifest.ownerId
      || !samePath(owner.root, root)
      || !samePath(manifest.root, root)
    ) return null;
    return { owner, manifest };
  } catch {
    return null;
  }
}

function createOwnership(configDir: string): { owner: ConfigOwner; manifest: ConfigUninstallManifest } | null {
  const rootStat = lstatSync(configDir);
  const existingEntries = readdirSync(configDir).filter(
    name => !isOwnershipInfrastructureName(name),
  );
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || existingEntries.length !== 0) return null;
  const owner: ConfigOwner = {
    version: 1,
    ownerId: randomUUID(),
    root: canonicalRoot(configDir),
  };
  const manifest: ConfigUninstallManifest = { ...owner, paths: [...INITIAL_OWNED_PATHS] };
  writeFileSync(join(configDir, CONFIG_OWNER_FILE), `${JSON.stringify(owner, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    writeFileSync(join(configDir, CONFIG_UNINSTALL_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    try { unlinkSync(join(configDir, CONFIG_OWNER_FILE)); } catch { /* incomplete metadata fails closed */ }
    throw error;
  }
  return { owner, manifest };
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

type OwnershipLockSnapshot = {
  token: string;
  ownerPid: number;
  mtimeMs: number;
};

function ownershipLockSnapshot(lockPath: string): OwnershipLockSnapshot | null {
  try {
    const metadata = lstatSync(lockPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > OWNERSHIP_LOCK_MAX_BYTES) {
      return null;
    }
    const token = readFileSync(lockPath, "utf8");
    const match = /^([1-9]\d*):[0-9a-f-]+\n$/i.exec(token);
    if (!match) return null;
    const ownerPid = Number(match[1]);
    return Number.isSafeInteger(ownerPid)
      ? { token, ownerPid, mtimeMs: metadata.mtimeMs }
      : null;
  } catch {
    return null;
  }
}

function isOwnershipLockPublishTempName(name: string): boolean {
  if (!name.startsWith(OWNERSHIP_LOCK_PUBLISH_TEMP_PREFIX)) return false;
  return /^[1-9]\d*-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i.test(
    name.slice(OWNERSHIP_LOCK_PUBLISH_TEMP_PREFIX.length),
  );
}

export function isOwnershipInfrastructureName(name: string): boolean {
  return name === OWNERSHIP_LOCK_FILE
    || name === OWNERSHIP_RECOVERY_LOCK_FILE
    || name.startsWith(OWNERSHIP_RECOVERY_CLAIM_PREFIX)
    || isOwnershipLockPublishTempName(name);
}

type OwnershipLockFileIdentity = {
  device: number;
  inode: number;
  size: number;
};

function lockFileIdentity(metadata: { dev: number; ino: number; size: number }): OwnershipLockFileIdentity {
  return {
    device: metadata.dev,
    inode: metadata.ino,
    size: metadata.size,
  };
}

function isSameLockFile(
  metadata: { dev: number; ino: number },
  identity: OwnershipLockFileIdentity,
): boolean {
  return metadata.dev === identity.device && metadata.ino === identity.inode;
}

function readExpectedLockToken(descriptor: number, identity: OwnershipLockFileIdentity, token: string): boolean {
  const expectedBytes = Buffer.from(token, "utf8");
  if (identity.size !== expectedBytes.byteLength) return false;
  const actualBytes = Buffer.alloc(identity.size);
  let offset = 0;
  while (offset < actualBytes.byteLength) {
    const bytesRead = readSync(
      descriptor,
      actualBytes,
      offset,
      actualBytes.byteLength - offset,
      offset,
    );
    if (bytesRead === 0) return false;
    offset += bytesRead;
  }
  return actualBytes.equals(expectedBytes);
}

function unlinkPublishTempIfOwned(path: string, identity: OwnershipLockFileIdentity): void {
  try {
    const current = lstatSync(path);
    if (current.isFile() && !current.isSymbolicLink() && isSameLockFile(current, identity)) {
      unlinkSync(path);
    }
  } catch {
    // Missing or replaced paths are never removed on behalf of this publisher.
  }
}

function removeVerifiedOwnershipLock(path: string, token: string): boolean {
  try {
    if (ownershipLockSnapshot(path)?.token !== token) return false;
    const identity = lockFileIdentity(lstatSync(path));
    if (ownershipLockSnapshot(path)?.token !== token) return false;
    unlinkPublishTempIfOwned(path, identity);
    return !existsSync(path);
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
}

function publishOwnershipLock(configDir: string, lockPath: string, token: string): boolean {
  const tempPath = join(
    configDir,
    `${OWNERSHIP_LOCK_PUBLISH_TEMP_PREFIX}${process.pid}-${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  let identity: OwnershipLockFileIdentity | undefined;
  try {
    descriptor = openSync(tempPath, "wx+", 0o600);
    writeFileSync(descriptor, token, { encoding: "utf8" });
    fsyncSync(descriptor);
    const prepared = fstatSync(descriptor);
    identity = lockFileIdentity(prepared);
    if (
      !prepared.isFile()
      || prepared.isSymbolicLink()
      || !readExpectedLockToken(descriptor, identity, token)
    ) {
      throw new Error("ownership lock temporary file was not written completely");
    }
    try {
      linkSync(tempPath, lockPath);
    } catch (error) {
      if (errorCode(error) === "EEXIST") return false;
      throw error;
    }

    const publishedPath = lstatSync(lockPath);
    if (
      !publishedPath.isFile()
      || publishedPath.isSymbolicLink()
      || !isSameLockFile(publishedPath, identity)
      || publishedPath.size !== identity.size
    ) {
      throw new Error("ownership lock publication identity mismatch");
    }
    const publishedDescriptor = openSync(lockPath, "r");
    try {
      const published = fstatSync(publishedDescriptor);
      if (
        !published.isFile()
        || published.isSymbolicLink()
        || !isSameLockFile(published, identity)
        || published.size !== identity.size
        || !readExpectedLockToken(publishedDescriptor, identity, token)
      ) {
        throw new Error("ownership lock publication token mismatch");
      }
      const verifiedPath = lstatSync(lockPath);
      if (
        !verifiedPath.isFile()
        || verifiedPath.isSymbolicLink()
        || !isSameLockFile(verifiedPath, identity)
        || verifiedPath.size !== identity.size
      ) {
        throw new Error("ownership lock publication changed during verification");
      }
      const linearized = fstatSync(publishedDescriptor);
      if (
        !linearized.isFile()
        || linearized.isSymbolicLink()
        || !isSameLockFile(linearized, identity)
        || linearized.size !== identity.size
        || !readExpectedLockToken(publishedDescriptor, identity, token)
      ) {
        throw new Error("ownership lock publication changed at final verification");
      }
      return true;
    } finally {
      closeSync(publishedDescriptor);
    }
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* failure remains fail-closed before publication */ }
    }
    if (identity) unlinkPublishTempIfOwned(tempPath, identity);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function releaseOwnedLock(lockPath: string, token: string): void {
  removeVerifiedOwnershipLock(lockPath, token);
}

function touchOwnershipLock(lockPath: string, token: string): void {
  let descriptor: number | undefined;
  try {
    if (ownershipLockSnapshot(lockPath)?.token !== token) return;
    descriptor = openSync(lockPath, "r+");
    const current = fstatSync(descriptor);
    const identity = lockFileIdentity(current);
    if (
      !current.isFile()
      || current.isSymbolicLink()
      || !readExpectedLockToken(descriptor, identity, token)
    ) return;
    const now = new Date();
    futimesSync(descriptor, now, now);
  } catch {
    // Lease refresh is best-effort; token-checked release remains authoritative.
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
  }
}

function staleDeadLock(snapshot: OwnershipLockSnapshot): boolean {
  return Date.now() - snapshot.mtimeMs > OWNERSHIP_LOCK_STALE_MS
    && !isProcessAlive(snapshot.ownerPid);
}

function recoveryClaimPaths(configDir: string): string[] {
  return readdirSync(configDir)
    .filter(name => name.startsWith(OWNERSHIP_RECOVERY_CLAIM_PREFIX))
    .map(name => join(configDir, name));
}

function recoveryClaimsAreClear(configDir: string): boolean {
  for (const claimPath of recoveryClaimPaths(configDir)) {
    const observed = ownershipLockSnapshot(claimPath);
    if (!observed || !staleDeadLock(observed)) return false;
    const current = ownershipLockSnapshot(claimPath);
    if (!current || current.token !== observed.token || !staleDeadLock(current)) return false;
    if (!removeVerifiedOwnershipLock(claimPath, current.token)) return false;
  }
  return true;
}

function moveStaleRecoveryLockToClaim(configDir: string, recoveryPath: string): boolean {
  const observed = ownershipLockSnapshot(recoveryPath);
  if (!observed || !staleDeadLock(observed)) return false;
  const claimPath = join(
    configDir,
    `${OWNERSHIP_RECOVERY_CLAIM_PREFIX}${process.pid}-${randomUUID()}`,
  );
  try {
    renameSync(recoveryPath, claimPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    return false;
  }

  const claimed = ownershipLockSnapshot(claimPath);
  if (!claimed || claimed.token !== observed.token || !staleDeadLock(claimed)) {
    // A successor moved during the race remains an active claim until its owner releases it.
    return false;
  }
  const current = ownershipLockSnapshot(claimPath);
  if (!current || current.token !== claimed.token || !staleDeadLock(current)) return false;
  return removeVerifiedOwnershipLock(claimPath, current.token);
}

function releaseRecoveryLock(configDir: string, token: string): void {
  const paths = [join(configDir, OWNERSHIP_RECOVERY_LOCK_FILE)];
  try { paths.push(...recoveryClaimPaths(configDir)); } catch { /* fixed-path cleanup still applies */ }
  for (const path of paths) {
    removeVerifiedOwnershipLock(path, token);
  }
}

function acquireRecoveryLock(configDir: string): { token: string } | null {
  const recoveryPath = join(configDir, OWNERSHIP_RECOVERY_LOCK_FILE);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!recoveryClaimsAreClear(configDir)) return null;
    const token = `${process.pid}:${randomUUID()}\n`;
    if (!publishOwnershipLock(configDir, recoveryPath, token)) {
      if (!moveStaleRecoveryLockToClaim(configDir, recoveryPath)) return null;
      continue;
    }

    try {
      if (!recoveryClaimsAreClear(configDir)) {
        releaseOwnedLock(recoveryPath, token);
        return null;
      }
    } catch (error) {
      releaseOwnedLock(recoveryPath, token);
      throw error;
    }
    return { token };
  }
  return null;
}

function reclaimStaleOwnershipLock(
  configDir: string,
  lockPath: string,
  observed: OwnershipLockSnapshot,
): boolean {
  const recoveryLock = acquireRecoveryLock(configDir);
  if (!recoveryLock) return false;

  try {
    const current = ownershipLockSnapshot(lockPath);
    if (
      !current
      || current.token !== observed.token
      || Date.now() - current.mtimeMs <= OWNERSHIP_LOCK_STALE_MS
      || isProcessAlive(current.ownerPid)
    ) {
      return false;
    }
    return removeVerifiedOwnershipLock(lockPath, current.token);
  } finally {
    releaseRecoveryLock(configDir, recoveryLock.token);
  }
}

function withOwnershipLock<T>(
  configDir: string,
  action: (refreshLease: () => void) => T,
  options: ConfigOwnershipLockOptions = {},
): T {
  const lockPath = join(configDir, OWNERSHIP_LOCK_FILE);
  const token = `${process.pid}:${randomUUID()}\n`;
  const lockTimeoutMs = typeof options.lockTimeoutMs === "number"
    && Number.isFinite(options.lockTimeoutMs)
    && options.lockTimeoutMs >= 0
    ? options.lockTimeoutMs
    : OWNERSHIP_LOCK_TIMEOUT_MS;
  const leaseRefreshMs = typeof options.leaseRefreshMs === "number"
    && Number.isFinite(options.leaseRefreshMs)
    && options.leaseRefreshMs >= 0
    ? options.leaseRefreshMs
    : Math.floor(OWNERSHIP_LOCK_STALE_MS / 3);
  const deadline = Date.now() + lockTimeoutMs;
  let acquired = false;

  while (!acquired) {
    if (!publishOwnershipLock(configDir, lockPath, token)) {
      try {
        const observed = ownershipLockSnapshot(lockPath);
        if (
          observed
          && Date.now() - observed.mtimeMs > OWNERSHIP_LOCK_STALE_MS
          && !isProcessAlive(observed.ownerPid)
          && reclaimStaleOwnershipLock(configDir, lockPath, observed)
        ) {
          continue;
        }
      } catch (staleError) {
        if (errorCode(staleError) === "ENOENT") continue;
      }
      if (Date.now() >= deadline) throw new Error("timed out waiting for config ownership lock");
      Atomics.wait(ownershipLockWait, 0, 0, OWNERSHIP_LOCK_RETRY_MS);
      continue;
    }
    acquired = true;
  }

  let lastLeaseRefresh = Date.now();
  const refreshLease = (): void => {
    const now = Date.now();
    if (now - lastLeaseRefresh < leaseRefreshMs) return;
    touchOwnershipLock(lockPath, token);
    lastLeaseRefresh = now;
  };
  try {
    return action(refreshLease);
  } finally {
    releaseOwnedLock(lockPath, token);
  }
}

function writeManifest(configDir: string, manifest: ConfigUninstallManifest): void {
  const path = join(configDir, CONFIG_UNINSTALL_MANIFEST);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    renameSync(temp, path);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  }
}

function removeOwnedEntry(root: string, path: string, refreshLease: () => void): void {
  refreshLease();
  const realParent = realpathSync.native(dirname(path));
  if (!isWithinRoot(root, realParent)) {
    throw new Error(`owned path parent resolves outside the config root: ${path}`);
  }
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) {
    unlinkSync(path);
    return;
  }
  if (!entry.isDirectory()) {
    unlinkSync(path);
    return;
  }

  const realDirectory = realpathSync.native(path);
  if (!isWithinRoot(root, realDirectory)) {
    throw new Error(`owned directory resolves outside the config root: ${path}`);
  }
  for (const name of readdirSync(path)) {
    removeOwnedEntry(root, join(path, name), refreshLease);
  }
  rmdirSync(path);
}

export function recordOwnedConfigPath(
  configDir: string,
  candidatePath: string,
  options: ConfigOwnershipLockOptions = {},
): boolean {
  const rel = manifestRelativePath(configDir, candidatePath);
  if (!rel) return false;
  try {
    let mayCreateOwnership: boolean;
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true, mode: 0o700 });
      mayCreateOwnership = true;
    } else {
      mayCreateOwnership = readdirSync(configDir)
        .every(isOwnershipInfrastructureName);
    }
    return withOwnershipLock(configDir, () => {
      const ownership = loadOwnership(configDir)
        ?? (mayCreateOwnership ? createOwnership(configDir) : null);
      if (!ownership) return false;
      if (ownership.manifest.paths.includes(rel)) return true;
      if (ownership.manifest.paths.length >= MANIFEST_MAX_PATHS) return false;
      const manifest = {
        ...ownership.manifest,
        paths: [...ownership.manifest.paths, rel].sort(),
      };
      writeManifest(configDir, manifest);
      return true;
    }, options);
  } catch {
    return false;
  }
}

function removeOwnedConfigStateLocked(
  configDir: string,
  refreshLease: () => void,
): ConfigRemovalResult {
  const ownership = loadOwnership(configDir);
  if (!ownership) {
    return {
      status: "refused",
      reason: "config ownership metadata is missing or invalid",
      residualPaths: [configDir],
    };
  }
  const recoveryLock = acquireRecoveryLock(configDir);
  if (!recoveryLock) {
    return {
      status: "refused",
      reason: "config ownership recovery lock is active or invalid",
      residualPaths: [configDir],
    };
  }
  releaseRecoveryLock(configDir, recoveryLock.token);

  for (const rel of ownership.manifest.paths) {
    refreshLease();
    const path = manifestRelativePath(configDir, join(configDir, ...rel.split("/")));
    if (path !== rel) {
      return {
        status: "refused",
        reason: "config ownership manifest contains an unsafe path",
        residualPaths: [configDir],
      };
    }
  }

  const rootPath = canonicalRoot(configDir);
  for (const rel of ownership.manifest.paths) {
    refreshLease();
    const path = join(configDir, ...rel.split("/"));
    if (!existsSync(path)) continue;
    try {
      removeOwnedEntry(rootPath, path, refreshLease);
    } catch (error) {
      return {
        status: "partial",
        reason: `could not remove owned path ${rel}: ${error instanceof Error ? error.message : String(error)}`,
        residualPaths: [path],
      };
    }
  }

  try {
    refreshLease();
    unlinkSync(join(configDir, CONFIG_UNINSTALL_MANIFEST));
    unlinkSync(join(configDir, CONFIG_OWNER_FILE));
  } catch (error) {
    return {
      status: "partial",
      reason: `could not remove ownership metadata: ${error instanceof Error ? error.message : String(error)}`,
      residualPaths: readdirSync(configDir).map(name => join(configDir, name)),
    };
  }
  const residualPaths = readdirSync(configDir)
    .filter(name => !isOwnershipInfrastructureName(name))
    .map(name => join(configDir, name));
  if (residualPaths.length > 0) {
    return {
      status: "partial",
      reason: "unowned files remain in the config directory",
      residualPaths,
    };
  }
  return { status: "removed", residualPaths: [] };
}

export function removeOwnedConfigState(
  configDir: string,
  options: ConfigOwnershipLockOptions = {},
): ConfigRemovalResult {
  if (!existsSync(configDir)) return { status: "absent", residualPaths: [] };
  const root = lstatSync(configDir);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    return {
      status: "refused",
      reason: "config ownership root is not a real directory",
      residualPaths: [configDir],
    };
  }

  let result: ConfigRemovalResult;
  try {
    result = withOwnershipLock(
      configDir,
      refreshLease => removeOwnedConfigStateLocked(configDir, refreshLease),
      options,
    );
  } catch (error) {
    return {
      status: "refused",
      reason: `could not acquire config ownership lock: ${error instanceof Error ? error.message : String(error)}`,
      residualPaths: [configDir],
    };
  }
  if (result.status !== "removed") return result;

  try {
    rmdirSync(configDir);
  } catch (error) {
    return {
      status: "partial",
      reason: `could not remove the empty config directory: ${error instanceof Error ? error.message : String(error)}`,
      residualPaths: [configDir],
    };
  }
  return { status: "removed", residualPaths: [] };
}
