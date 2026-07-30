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

/**
 * Other `bun test` runners already on this machine.
 *
 * Two full suites sharing one CPU do not fail — they crawl. A run that normally
 * finishes in about 210s took 26 minutes against a runner an earlier session had
 * left behind, and neither process said anything, so the slowdown read as a hang
 * in this suite. Bun's own timeouts cannot see the contention, so name it here.
 *
 * `pgrep` is absent on Windows and may exit non-zero for "no matches"; both cases
 * mean "nothing to warn about" rather than an error worth failing a test run over.
 */
function findCompetingTestRunners(selfPid: number): number[] {
  try {
    const found = Bun.spawnSync(["pgrep", "-f", "bun.*test --isolate"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (!found.success) return [];
    return new TextDecoder().decode(found.stdout)
      .split("\n")
      .map(line => Number.parseInt(line.trim(), 10))
      .filter(pid => Number.isInteger(pid) && pid > 0 && pid !== selfPid);
  } catch {
    return [];
  }
}

if (import.meta.main) {
  const isolated = createIsolatedTestEnvironment();
  try {
    const requestedTests = process.argv.slice(2);
    const competing = findCompetingTestRunners(process.pid);
    if (competing.length > 0) {
      console.warn(
        `[test] ${competing.length} other bun test runner(s) are already running (pid ${competing.join(", ")}). `
        + "They share this machine's CPU, so this run will be much slower than usual and can look hung. "
        + "Stop them first if that is not what you meant.",
      );
    }
    const startedAt = Date.now();
    let exitCode = 0;
    for (const invocation of buildTestInvocations(requestedTests)) {
      const child = Bun.spawnSync(invocation, {
        env: isolated.env,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      exitCode = child.exitCode ?? 1;
      if (exitCode !== 0) {
        break;
      }
    }
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    const slowSuiteThresholdSeconds = process.platform === "win32" ? 1_200 : 600;
    if (requestedTests.length === 0 && elapsedSeconds > slowSuiteThresholdSeconds) {
      console.warn(
        `[test] the suite took ${elapsedSeconds}s, beyond the expected idle-machine budget. `
        + "Check for another test runner, a busy CPU, or a test that started polling something real.",
      );
    }
    process.exitCode = exitCode;
  } finally {
    isolated.cleanup();
  }
}
