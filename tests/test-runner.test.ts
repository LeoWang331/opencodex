import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { buildTestInvocations, createIsolatedTestEnvironment } from "../scripts/test";

describe("test runner isolation", () => {
  test("redirects user homes to a disposable root", () => {
    const isolated = createIsolatedTestEnvironment({ Path: "/test/bin", HOME: "/real/home" });
    try {
      expect(isolated.env).toMatchObject({
        PATH: [dirname(process.execPath), "/test/bin"].join(delimiter),
        HOME: isolated.root,
        USERPROFILE: isolated.root,
        OPENCODEX_HOME: join(isolated.root, ".opencodex"),
        CODEX_HOME: join(isolated.root, ".codex"),
      });
      expect(existsSync(isolated.env.OPENCODEX_HOME!)).toBe(true);
      expect(existsSync(isolated.env.CODEX_HOME!)).toBe(true);
      expect(isolated.env).not.toHaveProperty("Path");
    } finally {
      isolated.cleanup();
    }
    expect(existsSync(isolated.root)).toBe(false);
  });

  test("shards the full Windows suite but leaves other runs unchanged", () => {
    const windows = buildTestInvocations([], "win32", "bun");
    expect(windows).toHaveLength(8);
    expect(windows[0]).toEqual(["bun", "test", "--isolate", "--shard=1/8", "./tests/"]);
    expect(windows[7]).toEqual(["bun", "test", "--isolate", "--shard=8/8", "./tests/"]);

    expect(buildTestInvocations([], "linux", "bun"))
      .toEqual([["bun", "test", "--isolate", "./tests/"]]);
    expect(buildTestInvocations(["./tests/config.test.ts"], "win32", "bun"))
      .toEqual([["bun", "test", "--isolate", "./tests/config.test.ts"]]);
  });
});
