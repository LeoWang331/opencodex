import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_OWNER_FILE,
  CONFIG_UNINSTALL_MANIFEST,
  isOwnershipInfrastructureName,
  recordOwnedConfigPath,
  removeOwnedConfigState,
} from "../src/lib/config-ownership";
import { getDefaultConfig, saveConfig } from "../src/config";

describe("owned config uninstall", () => {
  test("uses one rule for every ownership infrastructure filename", () => {
    expect(isOwnershipInfrastructureName(".opencodex-owner.lock")).toBe(true);
    expect(isOwnershipInfrastructureName(".opencodex-owner-recovery.lock")).toBe(true);
    expect(isOwnershipInfrastructureName(".opencodex-owner-recovery.lock.claim-successor")).toBe(true);
    expect(isOwnershipInfrastructureName(
      ".opencodex-owner-lock-publish-99999999-00000000-0000-4000-8000-000000000012.tmp",
    )).toBe(true);
    expect(isOwnershipInfrastructureName("config.json")).toBe(false);
  });

  test("first owned write creates a missing config root and its metadata", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-first-owned-path-"));
    const dir = join(parent, "config");

    try {
      expect(recordOwnedConfigPath(dir, join(dir, "usage.jsonl"))).toBe(true);
      expect(existsSync(join(dir, CONFIG_OWNER_FILE))).toBe(true);
      expect(existsSync(join(dir, CONFIG_UNINSTALL_MANIFEST))).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("preserves ownership paths registered by another process", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-cross-process-"));
    const dir = join(parent, "config");
    const firstPath = join(dir, "first.json");
    const childPath = join(dir, "child.json");
    const lastPath = join(dir, "last.json");
    const ownershipModule = new URL("../src/lib/config-ownership.ts", import.meta.url).href;

    try {
      expect(recordOwnedConfigPath(dir, firstPath)).toBe(true);
      const child = spawnSync(process.execPath, [
        "-e",
        `import { recordOwnedConfigPath } from ${JSON.stringify(ownershipModule)};
         if (!recordOwnedConfigPath(process.env.OCX_TEST_CONFIG_DIR, process.env.OCX_TEST_OWNED_PATH)) process.exit(42);`,
      ], {
        encoding: "utf8",
        env: {
          ...process.env,
          OCX_TEST_CONFIG_DIR: dir,
          OCX_TEST_OWNED_PATH: childPath,
        },
      });
      expect(child.status, child.stderr || child.stdout).toBe(0);
      expect(recordOwnedConfigPath(dir, lastPath)).toBe(true);

      const manifest = JSON.parse(
        readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), "utf8"),
      ) as { paths: string[] };
      expect(manifest.paths).toEqual(expect.arrayContaining([
        "first.json",
        "child.json",
        "last.json",
      ]));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("refuses registration without corrupting a full ownership manifest", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-manifest-limit-"));
    const dir = join(parent, "config");
    const firstPath = join(dir, "limit-0.json");

    try {
      expect(recordOwnedConfigPath(dir, firstPath)).toBe(true);
      const manifestPath = join(dir, CONFIG_UNINSTALL_MANIFEST);
      const initial = JSON.parse(readFileSync(manifestPath, "utf8")) as { paths: string[] };
      const fullManifest = {
        ...initial,
        paths: [
          ...initial.paths,
          ...Array.from(
            { length: 1024 - initial.paths.length },
            (_, index) => `limit-${index + 1}.json`,
          ),
        ].sort(),
      };
      writeFileSync(manifestPath, `${JSON.stringify(fullManifest, null, 2)}\n`);

      expect(recordOwnedConfigPath(dir, join(dir, "over-limit.json"))).toBe(false);
      const persisted = JSON.parse(readFileSync(manifestPath, "utf8")) as { paths: string[] };
      expect(persisted.paths).toHaveLength(1024);
      expect(persisted.paths).not.toContain("over-limit.json");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("serializes simultaneous ownership registrations across processes", async () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-simultaneous-"));
    const dir = join(parent, "config");
    const ownershipModule = new URL("../src/lib/config-ownership.ts", import.meta.url).href;
    const childPaths = Array.from({ length: 8 }, (_, index) => join(dir, `child-${index}.json`));
    const startAt = Date.now() + 1_000;

    try {
      expect(recordOwnedConfigPath(dir, join(dir, "seed.json"))).toBe(true);
      const results = await Promise.all(childPaths.map(childPath => new Promise<{
        code: number | null;
        stderr: string;
      }>((resolveChild, rejectChild) => {
        const child = spawn(process.execPath, [
          "-e",
          `import { recordOwnedConfigPath } from ${JSON.stringify(ownershipModule)};
           const delay = Number(process.env.OCX_TEST_START_AT) - Date.now();
           if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
           if (!recordOwnedConfigPath(process.env.OCX_TEST_CONFIG_DIR, process.env.OCX_TEST_OWNED_PATH)) process.exit(42);`,
        ], {
          env: {
            ...process.env,
            OCX_TEST_CONFIG_DIR: dir,
            OCX_TEST_OWNED_PATH: childPath,
            OCX_TEST_START_AT: String(startAt),
          },
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", chunk => { stderr += String(chunk); });
        child.once("error", rejectChild);
        child.once("exit", code => resolveChild({ code, stderr }));
      })));

      for (const result of results) expect(result.code, result.stderr).toBe(0);
      const manifest = JSON.parse(
        readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), "utf8"),
      ) as { paths: string[] };
      for (const childPath of childPaths) {
        expect(manifest.paths).toContain(childPath.slice(dir.length + 1).replaceAll("\\", "/"));
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 10_000);

  test("serializes simultaneous recovery of a stale ownership lock", async () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-stale-lock-race-"));
    const dir = join(parent, "config");
    const ownershipModule = new URL("../src/lib/config-ownership.ts", import.meta.url).href;
    const childPaths = Array.from({ length: 24 }, (_, index) => join(dir, `stale-${index}.json`));
    const startAt = Date.now() + 1_000;

    try {
      expect(recordOwnedConfigPath(dir, join(dir, "seed.json"))).toBe(true);
      const lockPath = join(dir, ".opencodex-owner.lock");
      writeFileSync(lockPath, "99999999:00000000-0000-4000-8000-000000000000\n", { flag: "wx" });
      const old = new Date(Date.now() - 60_000);
      utimesSync(lockPath, old, old);

      const results = await Promise.all(childPaths.map(childPath => new Promise<{
        code: number | null;
        stderr: string;
      }>((resolveChild, rejectChild) => {
        const child = spawn(process.execPath, [
          "-e",
          `import { recordOwnedConfigPath } from ${JSON.stringify(ownershipModule)};
           const delay = Number(process.env.OCX_TEST_START_AT) - Date.now();
           if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
           if (!recordOwnedConfigPath(
             process.env.OCX_TEST_CONFIG_DIR,
             process.env.OCX_TEST_OWNED_PATH,
             { lockTimeoutMs: 20_000 },
           )) process.exit(42);`,
        ], {
          env: {
            ...process.env,
            OCX_TEST_CONFIG_DIR: dir,
            OCX_TEST_OWNED_PATH: childPath,
            OCX_TEST_START_AT: String(startAt),
          },
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", chunk => { stderr += String(chunk); });
        child.once("error", rejectChild);
        child.once("exit", code => resolveChild({ code, stderr }));
      })));

      for (const result of results) expect(result.code, result.stderr).toBe(0);
      const manifest = JSON.parse(
        readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), "utf8"),
      ) as { paths: string[] };
      for (const childPath of childPaths) {
        expect(manifest.paths).toContain(childPath.slice(dir.length + 1).replaceAll("\\", "/"));
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 30_000);

  test("recovers stale main and recovery locks left by dead processes", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-stale-recovery-lock-"));
    const dir = join(parent, "config");
    const nextPath = join(dir, "next.json");
    const mainLockPath = join(dir, ".opencodex-owner.lock");
    const recoveryLockPath = join(dir, ".opencodex-owner-recovery.lock");

    try {
      expect(recordOwnedConfigPath(dir, join(dir, "seed.json"))).toBe(true);
      writeFileSync(mainLockPath, "99999999:00000000-0000-4000-8000-000000000001\n", { flag: "wx" });
      writeFileSync(recoveryLockPath, "99999999:00000000-0000-4000-8000-000000000002\n", { flag: "wx" });
      const old = new Date(Date.now() - 60_000);
      utimesSync(mainLockPath, old, old);
      utimesSync(recoveryLockPath, old, old);

      expect(recordOwnedConfigPath(dir, nextPath)).toBe(true);
      const manifest = JSON.parse(
        readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), "utf8"),
      ) as { paths: string[] };
      expect(manifest.paths).toContain("next.json");
      expect(existsSync(recoveryLockPath)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 10_000);

  test("does not bypass or delete a live recovery successor claim", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-live-recovery-claim-"));
    const dir = join(parent, "config");
    const nextPath = join(dir, "next.json");
    const mainLockPath = join(dir, ".opencodex-owner.lock");
    const recoveryClaimPath = join(
      dir,
      ".opencodex-owner-recovery.lock.claim-live-successor",
    );

    try {
      expect(recordOwnedConfigPath(dir, join(dir, "seed.json"))).toBe(true);
      const mainToken = "99999999:00000000-0000-4000-8000-000000000003\n";
      const claimToken = `${process.pid}:00000000-0000-4000-8000-000000000004\n`;
      writeFileSync(mainLockPath, mainToken, { flag: "wx" });
      writeFileSync(recoveryClaimPath, claimToken, { flag: "wx" });
      const old = new Date(Date.now() - 60_000);
      utimesSync(mainLockPath, old, old);
      utimesSync(recoveryClaimPath, old, old);

      expect(recordOwnedConfigPath(dir, nextPath, { lockTimeoutMs: 25 })).toBe(false);
      expect(readFileSync(mainLockPath, "utf8")).toBe(mainToken);
      expect(readFileSync(recoveryClaimPath, "utf8")).toBe(claimToken);
      const manifest = JSON.parse(
        readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), "utf8"),
      ) as { paths: string[] };
      expect(manifest.paths).not.toContain("next.json");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 10_000);

  test("does not delete a live fixed recovery lock", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-live-recovery-lock-"));
    const dir = join(parent, "config");
    const nextPath = join(dir, "next.json");
    const mainLockPath = join(dir, ".opencodex-owner.lock");
    const recoveryLockPath = join(dir, ".opencodex-owner-recovery.lock");

    try {
      expect(recordOwnedConfigPath(dir, join(dir, "seed.json"))).toBe(true);
      const mainToken = "99999999:00000000-0000-4000-8000-000000000005\n";
      const recoveryToken = `${process.pid}:00000000-0000-4000-8000-000000000006\n`;
      writeFileSync(mainLockPath, mainToken, { flag: "wx" });
      writeFileSync(recoveryLockPath, recoveryToken, { flag: "wx" });
      const old = new Date(Date.now() - 60_000);
      utimesSync(mainLockPath, old, old);
      utimesSync(recoveryLockPath, old, old);

      expect(recordOwnedConfigPath(dir, nextPath, { lockTimeoutMs: 25 })).toBe(false);
      expect(readFileSync(mainLockPath, "utf8")).toBe(mainToken);
      expect(readFileSync(recoveryLockPath, "utf8")).toBe(recoveryToken);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 10_000);

  test("does not reclaim an old lock held by a live process", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-live-lock-"));
    const dir = join(parent, "config");
    const nextPath = join(dir, "next.json");
    const lockPath = join(dir, ".opencodex-owner.lock");

    try {
      expect(recordOwnedConfigPath(dir, join(dir, "seed.json"))).toBe(true);
      const lockToken = `${process.pid}:00000000-0000-4000-8000-000000000000\n`;
      writeFileSync(lockPath, lockToken, { flag: "wx" });
      const old = new Date(Date.now() - 60_000);
      utimesSync(lockPath, old, old);

      expect(recordOwnedConfigPath(dir, nextPath, { lockTimeoutMs: 25 })).toBe(false);
      expect(readFileSync(lockPath, "utf8")).toBe(lockToken);
      const manifest = JSON.parse(
        readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), "utf8"),
      ) as { paths: string[] };
      expect(manifest.paths).not.toContain("next.json");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 10_000);

  test("refuses uninstall while the ownership registration lock is held", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-locked-uninstall-"));
    const dir = join(parent, "config");
    const ownedPath = join(dir, "config.json");
    const lockPath = join(dir, ".opencodex-owner.lock");

    try {
      expect(recordOwnedConfigPath(dir, ownedPath)).toBe(true);
      writeFileSync(ownedPath, '{"owned":true}\n');
      const lockToken = `${process.pid}:00000000-0000-4000-8000-000000000000\n`;
      writeFileSync(lockPath, lockToken, { flag: "wx" });

      const result = removeOwnedConfigState(dir, { lockTimeoutMs: 25 });
      expect(result.status).toBe("refused");
      expect(readFileSync(ownedPath, "utf8")).toBe('{"owned":true}\n');
      expect(existsSync(join(dir, CONFIG_OWNER_FILE))).toBe(true);
      expect(existsSync(join(dir, CONFIG_UNINSTALL_MANIFEST))).toBe(true);
      expect(readFileSync(lockPath, "utf8")).toBe(lockToken);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 10_000);

  test("does not expose or reclaim a lock holder paused before atomic publication", async () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-prepublish-pause-"));
    const dir = join(parent, "config");
    const ownedPath = join(dir, "config.json");
    const lockPath = join(dir, ".opencodex-owner.lock");
    const publisherReadyPath = join(parent, "publisher-ready");
    const publisherReleasePath = join(parent, "publisher-release");
    const ownershipModule = new URL("../src/lib/config-ownership.ts", import.meta.url).href;
    mkdirSync(dir);

    const child = spawn(process.execPath, [
      "-e",
      `import { mock } from "bun:test";
       const actualFs = await import("node:fs");
       const actualLinkSync = actualFs.linkSync;
       mock.module("node:fs", () => ({
         ...actualFs,
         linkSync(source, target) {
           actualFs.writeFileSync(process.env.OCX_TEST_PUBLISH_READY, "ready");
           const wait = new Int32Array(new SharedArrayBuffer(4));
           const deadline = Date.now() + 3000;
           while (!actualFs.existsSync(process.env.OCX_TEST_PUBLISH_RELEASE) && Date.now() < deadline) {
             Atomics.wait(wait, 0, 0, 1);
           }
           if (!actualFs.existsSync(process.env.OCX_TEST_PUBLISH_RELEASE)) process.exit(43);
           return actualLinkSync(source, target);
         },
       }));
       const { recordOwnedConfigPath } = await import(${JSON.stringify(ownershipModule)});
       if (recordOwnedConfigPath(process.env.OCX_TEST_CONFIG_DIR, process.env.OCX_TEST_OWNED_PATH)) {
         process.exit(42);
       }
       process.exit(0);`,
    ], {
      env: {
        ...process.env,
        OCX_TEST_CONFIG_DIR: dir,
        OCX_TEST_OWNED_PATH: ownedPath,
        OCX_TEST_PUBLISH_READY: publisherReadyPath,
        OCX_TEST_PUBLISH_RELEASE: publisherReleasePath,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", chunk => { stderr += String(chunk); });

    try {
      const readyDeadline = Date.now() + 2_000;
      while (!existsSync(publisherReadyPath) && Date.now() < readyDeadline) await Bun.sleep(1);
      expect(existsSync(publisherReadyPath), stderr).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
      const publishTemps = readdirSync(dir)
        .filter(name => name.startsWith(".opencodex-owner-lock-publish-"));
      expect(publishTemps).toHaveLength(1);
      expect(readFileSync(join(dir, publishTemps[0]!), "utf8"))
        .toMatch(/^[1-9]\d*:[0-9a-f-]+\n$/i);

      const competingToken = `${process.pid}:00000000-0000-4000-8000-000000000010\n`;
      writeFileSync(lockPath, competingToken, { flag: "wx" });
      const old = new Date(Date.now() - 60_000);
      utimesSync(lockPath, old, old);
      writeFileSync(publisherReleasePath, "release");

      const exitCode = await new Promise<number | null>((resolveChild, rejectChild) => {
        child.once("error", rejectChild);
        child.once("exit", resolveChild);
      });
      expect(exitCode, stderr).toBe(0);
      expect(readFileSync(lockPath, "utf8")).toBe(competingToken);
      expect(existsSync(join(dir, CONFIG_OWNER_FILE))).toBe(false);
      expect(readdirSync(dir).some(
        name => name.startsWith(".opencodex-owner-lock-publish-"),
      )).toBe(false);
    } finally {
      child.kill();
      rmSync(parent, { recursive: true, force: true });
    }
  }, 10_000);

  test("fails closed when atomic hard-link publication is unavailable", async () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-link-failure-"));
    const dir = join(parent, "config");
    const ownedPath = join(dir, "config.json");
    const lockPath = join(dir, ".opencodex-owner.lock");
    const ownershipModule = new URL("../src/lib/config-ownership.ts", import.meta.url).href;
    mkdirSync(dir);

    const child = spawn(process.execPath, [
      "-e",
      `import { mock } from "bun:test";
       const actualFs = await import("node:fs");
       mock.module("node:fs", () => ({
         ...actualFs,
         linkSync() {
           const error = new Error("hard links unavailable");
           error.code = "EPERM";
           throw error;
         },
       }));
       const { recordOwnedConfigPath } = await import(${JSON.stringify(ownershipModule)});
       process.exit(recordOwnedConfigPath(
         process.env.OCX_TEST_CONFIG_DIR,
         process.env.OCX_TEST_OWNED_PATH,
       ) ? 42 : 0);`,
    ], {
      env: {
        ...process.env,
        OCX_TEST_CONFIG_DIR: dir,
        OCX_TEST_OWNED_PATH: ownedPath,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", chunk => { stderr += String(chunk); });

    try {
      const exitCode = await new Promise<number | null>((resolveChild, rejectChild) => {
        child.once("error", rejectChild);
        child.once("exit", resolveChild);
      });
      expect(exitCode, stderr).toBe(0);
      expect(existsSync(lockPath)).toBe(false);
      expect(existsSync(join(dir, CONFIG_OWNER_FILE))).toBe(false);
      expect(readdirSync(dir).some(
        name => name.startsWith(".opencodex-owner-lock-publish-"),
      )).toBe(false);
    } finally {
      child.kill();
      rmSync(parent, { recursive: true, force: true });
    }
  }, 10_000);

  test("rejects a source replacement injected immediately before publication", async () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-publish-source-replaced-"));
    const dir = join(parent, "config");
    const ownedPath = join(dir, "config.json");
    const lockPath = join(dir, ".opencodex-owner.lock");
    const attackerSourcePath = join(parent, "attacker-source");
    const attackerToken = `${process.pid}:00000000-0000-4000-8000-000000000014\n`;
    const ownershipModule = new URL("../src/lib/config-ownership.ts", import.meta.url).href;
    mkdirSync(dir);

    const child = spawn(process.execPath, [
      "-e",
      `import { mock } from "bun:test";
       const actualFs = await import("node:fs");
       const actualLinkSync = actualFs.linkSync;
       mock.module("node:fs", () => ({
         ...actualFs,
         linkSync(source, target) {
           actualFs.writeFileSync(
             process.env.OCX_TEST_ATTACKER_SOURCE,
             process.env.OCX_TEST_ATTACKER_TOKEN,
             { flag: "wx" },
           );
           return actualLinkSync(process.env.OCX_TEST_ATTACKER_SOURCE, target);
         },
       }));
       const { recordOwnedConfigPath } = await import(${JSON.stringify(ownershipModule)});
       process.exit(recordOwnedConfigPath(
         process.env.OCX_TEST_CONFIG_DIR,
         process.env.OCX_TEST_OWNED_PATH,
       ) ? 42 : 0);`,
    ], {
      env: {
        ...process.env,
        OCX_TEST_CONFIG_DIR: dir,
        OCX_TEST_OWNED_PATH: ownedPath,
        OCX_TEST_ATTACKER_SOURCE: attackerSourcePath,
        OCX_TEST_ATTACKER_TOKEN: attackerToken,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", chunk => { stderr += String(chunk); });

    try {
      const exitCode = await new Promise<number | null>((resolveChild, rejectChild) => {
        child.once("error", rejectChild);
        child.once("exit", resolveChild);
      });
      expect(exitCode, stderr).toBe(0);
      expect(readFileSync(lockPath, "utf8")).toBe(attackerToken);
      expect(existsSync(join(dir, CONFIG_OWNER_FILE))).toBe(false);
    } finally {
      child.kill();
      rmSync(parent, { recursive: true, force: true });
    }
  }, 10_000);

  test("preserves a competing lock that replaces the fixed name after linking", async () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-published-lock-replaced-"));
    const dir = join(parent, "config");
    const ownedPath = join(dir, "config.json");
    const lockPath = join(dir, ".opencodex-owner.lock");
    const competingToken = `${process.pid}:00000000-0000-4000-8000-000000000015\n`;
    const ownershipModule = new URL("../src/lib/config-ownership.ts", import.meta.url).href;
    mkdirSync(dir);

    const child = spawn(process.execPath, [
      "-e",
      `import { mock } from "bun:test";
       const actualFs = await import("node:fs");
       const actualLinkSync = actualFs.linkSync;
       mock.module("node:fs", () => ({
         ...actualFs,
         linkSync(source, target) {
           actualLinkSync(source, target);
           actualFs.unlinkSync(target);
           actualFs.writeFileSync(target, process.env.OCX_TEST_COMPETING_TOKEN, { flag: "wx" });
         },
       }));
       const { recordOwnedConfigPath } = await import(${JSON.stringify(ownershipModule)});
       process.exit(recordOwnedConfigPath(
         process.env.OCX_TEST_CONFIG_DIR,
         process.env.OCX_TEST_OWNED_PATH,
       ) ? 42 : 0);`,
    ], {
      env: {
        ...process.env,
        OCX_TEST_CONFIG_DIR: dir,
        OCX_TEST_OWNED_PATH: ownedPath,
        OCX_TEST_COMPETING_TOKEN: competingToken,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", chunk => { stderr += String(chunk); });

    try {
      const exitCode = await new Promise<number | null>((resolveChild, rejectChild) => {
        child.once("error", rejectChild);
        child.once("exit", resolveChild);
      });
      expect(exitCode, stderr).toBe(0);
      expect(readFileSync(lockPath, "utf8")).toBe(competingToken);
      expect(existsSync(join(dir, CONFIG_OWNER_FILE))).toBe(false);
    } finally {
      child.kill();
      rmSync(parent, { recursive: true, force: true });
    }
  }, 10_000);

  test("revalidates the open fixed lock after the final path identity check", async () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-final-lock-revalidation-"));
    const dir = join(parent, "config");
    const ownedPath = join(dir, "config.json");
    const lockPath = join(dir, ".opencodex-owner.lock");
    const injectionMarker = join(parent, "final-revalidation-injected");
    const ownershipModule = new URL("../src/lib/config-ownership.ts", import.meta.url).href;
    mkdirSync(dir);

    const child = spawn(process.execPath, [
      "-e",
      `import { mock } from "bun:test";
       const actualFs = await import("node:fs");
       const actualLstatSync = actualFs.lstatSync;
       let fixedNameChecks = 0;
       mock.module("node:fs", () => ({
         ...actualFs,
         lstatSync(path, options) {
           if (path === process.env.OCX_TEST_LOCK_PATH) {
             fixedNameChecks += 1;
             if (fixedNameChecks === 2) {
               actualFs.writeFileSync(process.env.OCX_TEST_INJECTION_MARKER, "injected\\n");
               const token = actualFs.readFileSync(path, "utf8");
               const changed = token.slice(0, -2) + (token.at(-2) === "a" ? "b" : "a") + "\\n";
               actualFs.writeFileSync(path, changed);
             }
           }
           return actualLstatSync(path, options);
         },
       }));
       const { recordOwnedConfigPath } = await import(${JSON.stringify(ownershipModule)});
       process.exit(recordOwnedConfigPath(
         process.env.OCX_TEST_CONFIG_DIR,
         process.env.OCX_TEST_OWNED_PATH,
       ) ? 42 : 0);`,
    ], {
      env: {
        ...process.env,
        OCX_TEST_CONFIG_DIR: dir,
        OCX_TEST_OWNED_PATH: ownedPath,
        OCX_TEST_LOCK_PATH: lockPath,
        OCX_TEST_INJECTION_MARKER: injectionMarker,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", chunk => { stderr += String(chunk); });

    try {
      const exitCode = await new Promise<number | null>((resolveChild, rejectChild) => {
        child.once("error", rejectChild);
        child.once("exit", resolveChild);
      });
      expect(exitCode, stderr).toBe(0);
      expect(existsSync(injectionMarker)).toBe(true);
      expect(existsSync(join(dir, CONFIG_OWNER_FILE))).toBe(false);
    } finally {
      child.kill();
      rmSync(parent, { recursive: true, force: true });
    }
  }, 10_000);

  test("leaves a fail-closed fixed lock when its published token changes", async () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-published-token-changed-"));
    const dir = join(parent, "config");
    const ownedPath = join(dir, "config.json");
    const lockPath = join(dir, ".opencodex-owner.lock");
    const ownershipModule = new URL("../src/lib/config-ownership.ts", import.meta.url).href;
    mkdirSync(dir);

    const child = spawn(process.execPath, [
      "-e",
      `import { mock } from "bun:test";
       const actualFs = await import("node:fs");
       const actualLinkSync = actualFs.linkSync;
       mock.module("node:fs", () => ({
         ...actualFs,
         linkSync(source, target) {
           actualLinkSync(source, target);
           const token = actualFs.readFileSync(target, "utf8");
           const changed = token.slice(0, -2) + (token.at(-2) === "a" ? "b" : "a") + "\\n";
           actualFs.writeFileSync(target, changed);
         },
       }));
       const { recordOwnedConfigPath } = await import(${JSON.stringify(ownershipModule)});
       process.exit(recordOwnedConfigPath(
         process.env.OCX_TEST_CONFIG_DIR,
         process.env.OCX_TEST_OWNED_PATH,
       ) ? 42 : 0);`,
    ], {
      env: {
        ...process.env,
        OCX_TEST_CONFIG_DIR: dir,
        OCX_TEST_OWNED_PATH: ownedPath,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", chunk => { stderr += String(chunk); });

    try {
      const exitCode = await new Promise<number | null>((resolveChild, rejectChild) => {
        child.once("error", rejectChild);
        child.once("exit", resolveChild);
      });
      expect(exitCode, stderr).toBe(0);
      expect(existsSync(lockPath)).toBe(true);
      expect(readFileSync(lockPath, "utf8")).toMatch(/^[1-9]\d*:[0-9a-f-]+\n$/i);
      expect(existsSync(join(dir, CONFIG_OWNER_FILE))).toBe(false);
      expect(readdirSync(dir).some(
        name => name.startsWith(".opencodex-owner-lock-publish-"),
      )).toBe(false);
    } finally {
      child.kill();
      rmSync(parent, { recursive: true, force: true });
    }
  }, 10_000);

  test("publishes a complete recovery lock through the same atomic path", async () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-recovery-publish-"));
    const dir = join(parent, "config");
    const nextPath = join(dir, "next.json");
    const mainLockPath = join(dir, ".opencodex-owner.lock");
    const recoveryObservationPath = join(parent, "recovery-observed");
    const ownershipModule = new URL("../src/lib/config-ownership.ts", import.meta.url).href;

    try {
      expect(recordOwnedConfigPath(dir, join(dir, "seed.json"))).toBe(true);
      writeFileSync(
        mainLockPath,
        "99999999:00000000-0000-4000-8000-000000000013\n",
        { flag: "wx" },
      );
      const old = new Date(Date.now() - 60_000);
      utimesSync(mainLockPath, old, old);

      const child = spawn(process.execPath, [
        "-e",
        `import { mock } from "bun:test";
         const actualFs = await import("node:fs");
         const actualLinkSync = actualFs.linkSync;
         mock.module("node:fs", () => ({
           ...actualFs,
           linkSync(source, target) {
             if (target.endsWith(".opencodex-owner-recovery.lock")) {
               if (actualFs.existsSync(target)) process.exit(43);
               const token = actualFs.readFileSync(source, "utf8");
               if (!/^[1-9]\\d*:[0-9a-f-]+\\n$/i.test(token)) process.exit(44);
               actualFs.writeFileSync(process.env.OCX_TEST_RECOVERY_OBSERVED, token);
             }
             return actualLinkSync(source, target);
           },
         }));
         const { recordOwnedConfigPath } = await import(${JSON.stringify(ownershipModule)});
         process.exit(recordOwnedConfigPath(
           process.env.OCX_TEST_CONFIG_DIR,
           process.env.OCX_TEST_OWNED_PATH,
         ) ? 0 : 42);`,
      ], {
        env: {
          ...process.env,
          OCX_TEST_CONFIG_DIR: dir,
          OCX_TEST_OWNED_PATH: nextPath,
          OCX_TEST_RECOVERY_OBSERVED: recoveryObservationPath,
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", chunk => { stderr += String(chunk); });
      const exitCode = await new Promise<number | null>((resolveChild, rejectChild) => {
        child.once("error", rejectChild);
        child.once("exit", resolveChild);
      });

      expect(exitCode, stderr).toBe(0);
      expect(readFileSync(recoveryObservationPath, "utf8"))
        .toMatch(/^[1-9]\d*:[0-9a-f-]+\n$/i);
      const manifest = JSON.parse(
        readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), "utf8"),
      ) as { paths: string[] };
      expect(manifest.paths).toContain("next.json");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 10_000);

  test("ignores but never deletes a crash-left publication temp file", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-publish-temp-remnant-"));
    const dir = join(parent, "config");
    const ownedPath = join(dir, "config.json");
    const tempPath = join(
      dir,
      ".opencodex-owner-lock-publish-99999999-00000000-0000-4000-8000-000000000012.tmp",
    );
    mkdirSync(dir);
    writeFileSync(tempPath, "incomplete pre-publication state");

    try {
      expect(recordOwnedConfigPath(dir, ownedPath)).toBe(true);
      expect(existsSync(join(dir, CONFIG_OWNER_FILE))).toBe(true);
      expect(readFileSync(tempPath, "utf8")).toBe("incomplete pre-publication state");

      const result = removeOwnedConfigState(dir);
      expect(result.status).toBe("partial");
      expect(result.residualPaths).toContain(dir);
      expect(readFileSync(tempPath, "utf8")).toBe("incomplete pre-publication state");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("refuses a stale empty fixed lock because its owner cannot be proven dead", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-stale-empty-lock-"));
    const dir = join(parent, "config");
    const ownedPath = join(dir, "config.json");
    const lockPath = join(dir, ".opencodex-owner.lock");
    mkdirSync(dir);
    writeFileSync(lockPath, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    try {
      expect(recordOwnedConfigPath(dir, ownedPath, { lockTimeoutMs: 25 })).toBe(false);
      expect(existsSync(join(dir, CONFIG_OWNER_FILE))).toBe(false);
      expect(existsSync(join(dir, CONFIG_UNINSTALL_MANIFEST))).toBe(false);
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 10_000);

  test("refuses a stale truncated recovery lock because its owner cannot be proven dead", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-stale-truncated-recovery-"));
    const dir = join(parent, "config");
    const ownedPath = join(dir, "config.json");
    const recoveryLockPath = join(dir, ".opencodex-owner-recovery.lock");

    try {
      expect(recordOwnedConfigPath(dir, ownedPath)).toBe(true);
      writeFileSync(ownedPath, '{"owned":true}\n');
      writeFileSync(recoveryLockPath, "99999999:00000000-0000-4");
      const old = new Date(Date.now() - 60_000);
      utimesSync(recoveryLockPath, old, old);

      expect(removeOwnedConfigState(dir).status).toBe("refused");
      expect(readFileSync(recoveryLockPath, "utf8")).toBe("99999999:00000000-0000-4");
      expect(readFileSync(ownedPath, "utf8")).toBe('{"owned":true}\n');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("does not reclaim arbitrary stale recovery-lock content", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-stale-invalid-recovery-"));
    const dir = join(parent, "config");
    const ownedPath = join(dir, "config.json");
    const recoveryLockPath = join(dir, ".opencodex-owner-recovery.lock");

    try {
      expect(recordOwnedConfigPath(dir, ownedPath)).toBe(true);
      writeFileSync(ownedPath, '{"owned":true}\n');
      writeFileSync(recoveryLockPath, "not an opencodex lock\n");
      const old = new Date(Date.now() - 60_000);
      utimesSync(recoveryLockPath, old, old);

      expect(removeOwnedConfigState(dir).status).toBe("refused");
      expect(readFileSync(recoveryLockPath, "utf8")).toBe("not an opencodex lock\n");
      expect(readFileSync(ownedPath, "utf8")).toBe('{"owned":true}\n');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("removes a stale fixed recovery lock before uninstalling owned state", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-stale-recovery-uninstall-"));
    const dir = join(parent, "config");
    const ownedPath = join(dir, "config.json");
    const recoveryLockPath = join(dir, ".opencodex-owner-recovery.lock");

    try {
      expect(recordOwnedConfigPath(dir, ownedPath)).toBe(true);
      writeFileSync(ownedPath, '{"owned":true}\n');
      writeFileSync(recoveryLockPath, "99999999:00000000-0000-4000-8000-000000000009\n");
      const old = new Date(Date.now() - 60_000);
      utimesSync(recoveryLockPath, old, old);

      expect(removeOwnedConfigState(dir)).toEqual({
        status: "removed",
        residualPaths: [],
      });
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("removes a stale recovery claim before uninstalling owned state", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-stale-claim-uninstall-"));
    const dir = join(parent, "config");
    const ownedPath = join(dir, "config.json");
    const recoveryClaimPath = join(
      dir,
      ".opencodex-owner-recovery.lock.claim-abandoned",
    );

    try {
      expect(recordOwnedConfigPath(dir, ownedPath)).toBe(true);
      writeFileSync(ownedPath, '{"owned":true}\n');
      writeFileSync(recoveryClaimPath, "99999999:00000000-0000-4000-8000-00000000000a\n");
      const old = new Date(Date.now() - 60_000);
      utimesSync(recoveryClaimPath, old, old);

      expect(removeOwnedConfigState(dir)).toEqual({
        status: "removed",
        residualPaths: [],
      });
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("refuses a stale truncated recovery claim because its owner cannot be proven dead", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-stale-truncated-claim-"));
    const dir = join(parent, "config");
    const ownedPath = join(dir, "config.json");
    const recoveryClaimPath = join(
      dir,
      ".opencodex-owner-recovery.lock.claim-abandoned-truncated",
    );

    try {
      expect(recordOwnedConfigPath(dir, ownedPath)).toBe(true);
      writeFileSync(ownedPath, '{"owned":true}\n');
      writeFileSync(recoveryClaimPath, "99999999:00000000-0000-4");
      const old = new Date(Date.now() - 60_000);
      utimesSync(recoveryClaimPath, old, old);

      expect(removeOwnedConfigState(dir).status).toBe("refused");
      expect(readFileSync(recoveryClaimPath, "utf8")).toBe("99999999:00000000-0000-4");
      expect(readFileSync(ownedPath, "utf8")).toBe('{"owned":true}\n');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("refuses uninstall and preserves metadata while a recovery lock is active", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-live-recovery-uninstall-"));
    const dir = join(parent, "config");
    const ownedPath = join(dir, "config.json");
    const recoveryLockPath = join(dir, ".opencodex-owner-recovery.lock");

    try {
      expect(recordOwnedConfigPath(dir, ownedPath)).toBe(true);
      writeFileSync(ownedPath, '{"owned":true}\n');
      const recoveryToken = `${process.pid}:00000000-0000-4000-8000-00000000000b\n`;
      writeFileSync(recoveryLockPath, recoveryToken, { flag: "wx" });
      const old = new Date(Date.now() - 60_000);
      utimesSync(recoveryLockPath, old, old);

      const result = removeOwnedConfigState(dir, { lockTimeoutMs: 25 });
      expect(result.status).toBe("refused");
      expect(readFileSync(ownedPath, "utf8")).toBe('{"owned":true}\n');
      expect(existsSync(join(dir, CONFIG_OWNER_FILE))).toBe(true);
      expect(existsSync(join(dir, CONFIG_UNINSTALL_MANIFEST))).toBe(true);
      expect(readFileSync(recoveryLockPath, "utf8")).toBe(recoveryToken);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("preserves a live recovery claim that replaces a verified stale claim", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-recovery-claim-swap-"));
    const dir = join(parent, "config");
    const ownedPath = join(dir, "config.json");
    const claimPath = join(
      dir,
      ".opencodex-owner-recovery.lock.claim-race",
    );
    const ownershipModule = new URL("../src/lib/config-ownership.ts", import.meta.url).href;
    const staleToken = "99999999:00000000-0000-4000-8000-000000000013\n";
    const successorToken = `${process.pid}:00000000-0000-4000-8000-000000000014\n`;

    try {
      expect(recordOwnedConfigPath(dir, ownedPath)).toBe(true);
      writeFileSync(ownedPath, '{"owned":true}\n');
      writeFileSync(claimPath, staleToken);
      const old = new Date(Date.now() - 60_000);
      utimesSync(claimPath, old, old);

      const child = spawnSync(process.execPath, [
        "-e",
        `import { mock } from "bun:test";
         const actualFs = await import("node:fs");
         const actualReadFileSync = actualFs.readFileSync;
         let claimReads = 0;
         mock.module("node:fs", () => ({
           ...actualFs,
           readFileSync(path, options) {
             const contents = actualReadFileSync(path, options);
             if (path === process.env.OCX_TEST_CLAIM_PATH) {
               claimReads += 1;
               if (claimReads === 2) {
                 actualFs.unlinkSync(path);
                 actualFs.writeFileSync(path, process.env.OCX_TEST_SUCCESSOR_TOKEN);
               }
             }
             return contents;
           },
         }));
         const { removeOwnedConfigState } = await import(${JSON.stringify(ownershipModule)});
         const result = removeOwnedConfigState(process.env.OCX_TEST_CONFIG_DIR);
         if (result.status !== "refused") process.exit(42);`,
      ], {
        encoding: "utf8",
        env: {
          ...process.env,
          OCX_TEST_CONFIG_DIR: dir,
          OCX_TEST_CLAIM_PATH: claimPath,
          OCX_TEST_SUCCESSOR_TOKEN: successorToken,
        },
      });

      expect(child.status, child.stderr || child.stdout).toBe(0);
      expect(readFileSync(claimPath, "utf8")).toBe(successorToken);
      expect(readFileSync(ownedPath, "utf8")).toBe('{"owned":true}\n');
      expect(existsSync(join(dir, CONFIG_OWNER_FILE))).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("refreshes the ownership lease during a manifest removal walk", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-lock-heartbeat-"));
    const dir = join(parent, "config");
    const ownedDir = join(dir, "artifacts");
    const markerPath = join(parent, "lease-refreshed");
    const ownershipModule = new URL("../src/lib/config-ownership.ts", import.meta.url).href;

    try {
      const child = spawnSync(process.execPath, [
        "-e",
        `import { mock } from "bun:test";
         const actualFs = await import("node:fs");
         const actualFutimesSync = actualFs.futimesSync;
         mock.module("node:fs", () => ({
           ...actualFs,
           futimesSync(descriptor, atime, mtime) {
             actualFs.writeFileSync(process.env.OCX_TEST_HEARTBEAT_MARKER, "refreshed\\n");
             return actualFutimesSync(descriptor, atime, mtime);
           },
         }));
         const { recordOwnedConfigPath, removeOwnedConfigState } = await import(${JSON.stringify(ownershipModule)});
         if (!recordOwnedConfigPath(process.env.OCX_TEST_CONFIG_DIR, process.env.OCX_TEST_OWNED_DIR)) process.exit(41);
         actualFs.mkdirSync(process.env.OCX_TEST_OWNED_DIR, { recursive: true });
         actualFs.writeFileSync(process.env.OCX_TEST_OWNED_FILE, "owned\\n");
         const result = removeOwnedConfigState(process.env.OCX_TEST_CONFIG_DIR, { leaseRefreshMs: 0 });
         if (result.status !== "removed") process.exit(42);`,
      ], {
        encoding: "utf8",
        env: {
          ...process.env,
          OCX_TEST_CONFIG_DIR: dir,
          OCX_TEST_OWNED_DIR: ownedDir,
          OCX_TEST_OWNED_FILE: join(ownedDir, "entry.txt"),
          OCX_TEST_HEARTBEAT_MARKER: markerPath,
        },
      });

      expect(child.status, child.stderr || child.stdout).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("returns false instead of throwing when ownership storage is inaccessible", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-registration-error-"));
    const blocker = join(parent, "not-a-directory");
    writeFileSync(blocker, "blocked\n");
    const dir = join(blocker, "config");

    try {
      expect(() => recordOwnedConfigPath(dir, join(dir, "config.json"))).not.toThrow();
      expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("refuses a legacy config directory without ownership metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-uninstall-legacy-"));
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, '{"keep":true}\n');

    try {
      const result = removeOwnedConfigState(dir);
      expect(result.status).toBe("refused");
      expect(result.reason).toContain("ownership");
      expect(readFileSync(configPath, "utf8")).toBe('{"keep":true}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not clean a recovery lock from an unowned legacy directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-uninstall-legacy-recovery-"));
    const recoveryLockPath = join(dir, ".opencodex-owner-recovery.lock");
    const recoveryToken = "99999999:00000000-0000-4000-8000-00000000000c\n";
    writeFileSync(recoveryLockPath, recoveryToken);
    const old = new Date(Date.now() - 60_000);
    utimesSync(recoveryLockPath, old, old);

    try {
      expect(removeOwnedConfigState(dir).status).toBe("refused");
      expect(readFileSync(recoveryLockPath, "utf8")).toBe(recoveryToken);
      expect(existsSync(join(dir, CONFIG_OWNER_FILE))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("treats a recovery lock as ownership infrastructure rather than legacy content", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-config-legacy-recovery-lock-"));
    const recoveryLock = join(dir, ".opencodex-owner-recovery.lock");
    writeFileSync(recoveryLock, "legacy content\n");

    try {
      expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
      expect(existsSync(join(dir, CONFIG_OWNER_FILE))).toBe(true);
      expect(readFileSync(recoveryLock, "utf8")).toBe("legacy content\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("claims an infrastructure-only directory after recovering abandoned locks", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-config-legacy-stale-locks-"));
    const mainLockPath = join(dir, ".opencodex-owner.lock");
    const recoveryLockPath = join(dir, ".opencodex-owner-recovery.lock");
    writeFileSync(mainLockPath, "99999999:00000000-0000-4000-8000-000000000007\n");
    writeFileSync(recoveryLockPath, "99999999:00000000-0000-4000-8000-000000000008\n");
    const old = new Date(Date.now() - 60_000);
    utimesSync(mainLockPath, old, old);
    utimesSync(recoveryLockPath, old, old);

    try {
      expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
      expect(existsSync(join(dir, CONFIG_OWNER_FILE))).toBe(true);
      expect(existsSync(join(dir, CONFIG_UNINSTALL_MANIFEST))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("removes manifest-owned state and the empty config directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-uninstall-owned-"));
    const configPath = join(dir, "config.json");

    try {
      expect(recordOwnedConfigPath(dir, configPath)).toBe(true);
      writeFileSync(configPath, '{"owned":true}\n');

      expect(removeOwnedConfigState(dir)).toEqual({
        status: "removed",
        residualPaths: [],
      });
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("preserves unowned files and reports a partial uninstall", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-uninstall-shared-"));
    const ownedPath = join(dir, "config.json");
    const foreignPath = join(dir, "personal.txt");

    try {
      expect(recordOwnedConfigPath(dir, ownedPath)).toBe(true);
      writeFileSync(ownedPath, '{"owned":true}\n');
      writeFileSync(foreignPath, "keep me\n");

      const result = removeOwnedConfigState(dir);
      expect(result.status).toBe("partial");
      expect(result.residualPaths).toEqual([foreignPath]);
      expect(existsSync(ownedPath)).toBe(false);
      expect(readFileSync(foreignPath, "utf8")).toBe("keep me\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("recursively removes a manifest-owned state directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-uninstall-tree-"));
    const artifacts = join(dir, "artifacts");

    try {
      expect(recordOwnedConfigPath(dir, artifacts)).toBe(true);
      mkdirSync(join(artifacts, "nested"), { recursive: true });
      writeFileSync(join(artifacts, "nested", "image.bin"), "owned");

      expect(removeOwnedConfigState(dir)).toEqual({
        status: "removed",
        residualPaths: [],
      });
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unlinks an owned directory link without traversing its external target", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-uninstall-link-"));
    const dir = join(parent, "config");
    const external = join(parent, "external");
    const linkedArtifacts = join(dir, "artifacts");
    mkdirSync(dir);
    mkdirSync(external);
    writeFileSync(join(external, "keep.bin"), "external");

    try {
      expect(recordOwnedConfigPath(dir, linkedArtifacts)).toBe(true);
      symlinkSync(external, linkedArtifacts, process.platform === "win32" ? "junction" : "dir");

      expect(removeOwnedConfigState(dir).status).toBe("removed");
      expect(readFileSync(join(external, "keep.bin"), "utf8")).toBe("external");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("refuses an owned file reached through a linked parent directory", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-uninstall-linked-parent-"));
    const dir = join(parent, "config");
    const external = join(parent, "external");
    const externalFile = join(external, "keep.txt");
    const linkedParent = join(dir, "linked-parent");
    mkdirSync(dir);
    mkdirSync(external);
    writeFileSync(externalFile, "external\n");

    try {
      expect(recordOwnedConfigPath(dir, join(dir, "seed.json"))).toBe(true);
      symlinkSync(external, linkedParent, process.platform === "win32" ? "junction" : "dir");
      expect(recordOwnedConfigPath(dir, join(linkedParent, "keep.txt"))).toBe(true);

      const result = removeOwnedConfigState(dir);
      expect(result.status).toBe("partial");
      expect(readFileSync(externalFile, "utf8")).toBe("external\n");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("rejects a manifest path that escapes the config directory", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-uninstall-traversal-"));
    const dir = join(parent, "config");
    const ownedPath = join(dir, "config.json");
    const external = join(parent, "keep.txt");
    mkdirSync(dir);
    writeFileSync(external, "external");

    try {
      expect(recordOwnedConfigPath(dir, ownedPath)).toBe(true);
      writeFileSync(ownedPath, "{}\n");
      const manifestPath = join(dir, CONFIG_UNINSTALL_MANIFEST);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { paths: string[] };
      manifest.paths = ["../keep.txt"];
      writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);

      expect(removeOwnedConfigState(dir).status).toBe("refused");
      expect(readFileSync(external, "utf8")).toBe("external");
      expect(readFileSync(ownedPath, "utf8")).toBe("{}\n");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("rejects linked ownership metadata without deleting owned state", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-uninstall-linked-metadata-"));
    const dir = join(parent, "config");
    const external = join(parent, "external");
    const ownedPath = join(dir, "config.json");
    mkdirSync(dir);
    mkdirSync(external);

    try {
      expect(recordOwnedConfigPath(dir, ownedPath)).toBe(true);
      writeFileSync(ownedPath, "{}\n");
      rmSync(join(dir, CONFIG_UNINSTALL_MANIFEST));
      symlinkSync(
        external,
        join(dir, CONFIG_UNINSTALL_MANIFEST),
        process.platform === "win32" ? "junction" : "dir",
      );

      expect(removeOwnedConfigState(dir).status).toBe("refused");
      expect(readFileSync(ownedPath, "utf8")).toBe("{}\n");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("a fresh config save creates ownership metadata and records config.json", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-first-write-"));
    const dir = join(parent, "config");
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = dir;

    try {
      saveConfig(getDefaultConfig());
      expect(existsSync(join(dir, CONFIG_OWNER_FILE))).toBe(true);
      const manifest = JSON.parse(
        readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), "utf8"),
      ) as { paths: string[] };
      expect(manifest.paths).toContain("config.json");
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("an existing nonempty config directory is not retroactively claimed", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-legacy-write-"));
    const dir = join(parent, "config");
    const foreignPath = join(dir, "personal.txt");
    mkdirSync(dir);
    writeFileSync(foreignPath, "keep me\n");
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = dir;

    try {
      saveConfig(getDefaultConfig());
      expect(existsSync(join(dir, CONFIG_OWNER_FILE))).toBe(false);
      expect(removeOwnedConfigState(dir).status).toBe("refused");
      expect(readFileSync(foreignPath, "utf8")).toBe("keep me\n");
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
