import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

const WINDOWS_FULL_SUITE_SHARDS = 8;

export interface IsolatedTestEnvironment {
  root: string;
  env: Record<string, string | undefined>;
  cleanup(): void;
}

export function createIsolatedTestEnvironment(
  baseEnv: Record<string, string | undefined> = process.env,
): IsolatedTestEnvironment {
  const root = mkdtempSync(join(tmpdir(), "opencodex-test-"));
  const opencodexHome = join(root, ".opencodex");
  const codexHome = join(root, ".codex");
  const inheritedPath = Object.entries(baseEnv)
    .find(([key]) => key.toLowerCase() === "path")?.[1];
  const normalizedBaseEnv = Object.fromEntries(
    Object.entries(baseEnv).filter(([key]) => key.toLowerCase() !== "path"),
  );
  mkdirSync(opencodexHome, { recursive: true });
  mkdirSync(codexHome, { recursive: true });

  return {
    root,
    env: {
      ...normalizedBaseEnv,
      PATH: [dirname(process.execPath), inheritedPath].filter(Boolean).join(delimiter),
      HOME: root,
      USERPROFILE: root,
      OPENCODEX_HOME: opencodexHome,
      CODEX_HOME: codexHome,
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function buildTestInvocations(
  requestedTests: string[],
  platform = process.platform,
  executable = process.execPath,
): string[][] {
  const base = [executable, "test", "--isolate"];
  if (requestedTests.length > 0) return [[...base, ...requestedTests]];
  if (platform !== "win32") return [[...base, "./tests/"]];

  // Bun 1.3.14 can crash internally on Windows when this service-heavy suite is
  // handed to one worker pool. Official shards keep every file covered exactly once
  // while bounding each pool's servers, workers, and native handles.
  return Array.from({ length: WINDOWS_FULL_SUITE_SHARDS }, (_, index) => [
    ...base,
    `--shard=${index + 1}/${WINDOWS_FULL_SUITE_SHARDS}`,
    "./tests/",
  ]);
}

if (import.meta.main) {
  const isolated = createIsolatedTestEnvironment();
  try {
    const requestedTests = process.argv.slice(2);
    for (const invocation of buildTestInvocations(requestedTests)) {
      const child = Bun.spawnSync(invocation, {
        env: isolated.env,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      const exitCode = child.exitCode ?? 1;
      if (exitCode !== 0) {
        process.exitCode = exitCode;
        break;
      }
    }
  } finally {
    isolated.cleanup();
  }
}
