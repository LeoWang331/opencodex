import { describe, expect, test } from "bun:test";
import {
  npmInvocation,
  resolveNpmCommand,
} from "../src/update/npm-invocation.mjs";

const cwd = "C:\\work\\untrusted-project";
const trustedNpm = "C:\\Program Files\\nodejs\\npm.cmd";
const systemCmd = "C:\\Windows\\System32\\cmd.exe";

describe("Windows npm update invocation", () => {
  test("ignores current-directory candidates and resolves npm from an absolute PATH entry", () => {
    const existing = new Set([
      `${cwd}\\npm.cmd`,
      trustedNpm,
    ]);
    const env = {
      PATH: `${cwd};.;C:\\Program Files\\nodejs`,
      PATHEXT: ".CMD",
      SystemRoot: "C:\\Windows",
    };

    expect(resolveNpmCommand("win32", env, {
      cwd,
      exists: path => existing.has(path),
    })).toBe(trustedNpm);

    const invocation = npmInvocation(["view", "pkg@latest", "version"], "win32", env, {
      cwd,
      exists: path => existing.has(path),
    });
    expect(invocation).toMatchObject({
      file: systemCmd,
      args: ["/d", "/s", "/c", expect.stringContaining("nodejs\\npm.cmd")],
      options: { windowsVerbatimArguments: true },
    });
    expect(String(invocation?.args.at(-1) ?? "").includes(cwd)).toBe(false);
  });

  test("resolves the default global npm prefix when the cwd is its ancestor", () => {
    // Regression: excluding the whole cwd subtree (rather than the cwd itself) hid npm's
    // default Windows global prefix `%AppData%\npm` from anyone whose shell sits in their
    // home directory, silently failing updates closed in a normal setup.
    const home = "C:\\Users\\dev";
    const appDataNpm = `${home}\\AppData\\Roaming\\npm\\npm.cmd`;
    const env = {
      PATH: `${home}\\AppData\\Roaming\\npm`,
      PATHEXT: ".CMD",
      SystemRoot: "C:\\Windows",
    };

    expect(resolveNpmCommand("win32", env, {
      cwd: home,
      exists: path => path === appDataNpm,
    })).toBe(appDataNpm);
  });

  test("still skips the current directory when it is a PATH entry under the home tree", () => {
    // The narrower rule must not lose the actual defense: a PATH entry equal to the
    // launch directory stays excluded even though it sits inside the user's home.
    const home = "C:\\Users\\dev";
    const project = `${home}\\untrusted`;
    const env = {
      PATH: `${project};${home}\\AppData\\Roaming\\npm`,
      PATHEXT: ".CMD",
      SystemRoot: "C:\\Windows",
    };
    const existing = new Set([
      `${project}\\npm.cmd`,
      `${home}\\AppData\\Roaming\\npm\\npm.cmd`,
    ]);

    expect(resolveNpmCommand("win32", env, {
      cwd: project,
      exists: path => existing.has(path),
    })).toBe(`${home}\\AppData\\Roaming\\npm\\npm.cmd`);
  });

  test("prevents a trusted npm.cmd shim from resolving node out of the launch directory", () => {
    const home = "C:\\Users\\dev";
    const project = `${home}\\untrusted`;
    const appDataNpmDir = `${home}\\AppData\\Roaming\\npm`;
    const appDataNpm = `${appDataNpmDir}\\npm.cmd`;
    const nodeDir = "C:\\Program Files\\nodejs";
    const env = {
      PATH: `${project};.;${appDataNpmDir};${nodeDir}`,
      PATHEXT: ".CMD",
      SystemRoot: "C:\\Windows",
      OCX_TEST_SENTINEL: "preserved",
      OPENCODEX_ADMIN_AUTH_TOKEN: "admin-secret",
      OCX_ADMIN_TOKEN_FILE: "C:\\secrets\\admin-token",
      OPENCODEX_API_AUTH_TOKEN: "data-secret",
      OCX_API_TOKEN_FILE: "C:\\secrets\\data-token",
    };

    const invocation = npmInvocation(["view", "pkg@latest", "version"], "win32", env, {
      cwd: project,
      exists: path => path === appDataNpm,
    });

    expect(invocation?.options).toMatchObject({
      windowsVerbatimArguments: true,
      env: {
        PATH: `${appDataNpmDir};${nodeDir}`,
        NoDefaultCurrentDirectoryInExePath: "1",
        OCX_TEST_SENTINEL: "preserved",
      },
    });
    for (const key of [
      "OPENCODEX_ADMIN_AUTH_TOKEN",
      "OCX_ADMIN_TOKEN_FILE",
      "OPENCODEX_API_AUTH_TOKEN",
      "OCX_API_TOKEN_FILE",
    ]) {
      expect(invocation?.options.env).not.toHaveProperty(key);
    }
  });

  test("fails closed when npm is available only from the current directory", () => {
    const env = {
      PATH: `${cwd};.`,
      PATHEXT: ".CMD",
      SystemRoot: "C:\\Windows",
    };

    expect(resolveNpmCommand("win32", env, {
      cwd,
      exists: path => path === `${cwd}\\npm.cmd`,
    })).toBeNull();
    expect(npmInvocation(["view", "pkg@latest", "version"], "win32", env, {
      cwd,
      exists: path => path === `${cwd}\\npm.cmd`,
    })).toBeNull();
  });
});

describe("POSIX npm update invocation", () => {
  test("ignores unsafe PATH entries and resolves npm from an absolute directory", () => {
    const project = "/work/untrusted-project";
    const trustedNpm = "/usr/local/bin/npm";
    const existing = new Set([
      `${project}/npm`,
      trustedNpm,
    ]);
    const env = {
      PATH: `${project}::.:relative-bin:/usr/local/bin`,
      OCX_TEST_SENTINEL: "preserved",
      OPENCODEX_ADMIN_AUTH_TOKEN: "admin-secret",
      OCX_ADMIN_TOKEN_FILE: "/run/secrets/admin-token",
      OPENCODEX_API_AUTH_TOKEN: "data-secret",
      OCX_API_TOKEN_FILE: "/run/secrets/data-token",
    };

    expect(resolveNpmCommand("linux", env, {
      cwd: project,
      exists: path => existing.has(path),
    })).toBe(trustedNpm);

    expect(npmInvocation(["view", "pkg@latest", "version"], "linux", env, {
      cwd: project,
      exists: path => existing.has(path),
    })).toEqual({
      file: trustedNpm,
      args: ["view", "pkg@latest", "version"],
      options: {
        env: {
          PATH: "/usr/local/bin",
          OCX_TEST_SENTINEL: "preserved",
        },
      },
    });
  });

  test("fails closed when PATH contains only relative or current-directory entries", () => {
    const project = "/work/untrusted-project";
    const env = {
      PATH: `${project}::.:relative-bin`,
    };
    const deps = {
      cwd: project,
      exists: () => true,
    };

    expect(resolveNpmCommand("darwin", env, deps)).toBeNull();
    expect(npmInvocation(["view", "pkg@latest", "version"], "darwin", env, deps)).toBeNull();
  });
});
