import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  adminApiTokenFilePath,
  configuredAdminToken,
  serviceAdminTokenFilePath,
} from "../src/lib/admin-secrets";
import { recordOwnedConfigPath } from "../src/lib/config-ownership";
import {
  loadServiceTokensIntoEnv,
  removeServiceTokenFiles,
  serviceApiTokenFilePath,
} from "../src/lib/service-secrets";
import { buildWinswXml } from "../src/lib/winsw";
import { initializeManagementAuthState } from "../src/server/management-auth";
import {
  isProxyAdmissionSecret,
  validateForwardAdmissionCredential,
} from "../src/server/auth-cors";
import type { OcxConfig } from "../src/types";
import {
  resetHardenedStateForTests,
  setIcaclsRunnerForTests,
  setPlatformForTests,
} from "../src/lib/windows-secret-acl";
import {
  buildPlist,
  buildUnit,
  buildWindowsServiceScript,
  withServiceTokenInstallTransaction,
  withServiceTokenInstallTransactionAsync,
  writeServiceApiTokenFile,
  writeServiceAdminTokenFile,
} from "../src/service";

const tempRoots: string[] = [];
const originalOpenCodexHome = process.env.OPENCODEX_HOME;
const originalAdminToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
const originalAdminTokenFile = process.env.OCX_ADMIN_TOKEN_FILE;
const originalUsername = process.env.USERNAME;
const originalUserDomain = process.env.USERDOMAIN;

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ocx-service-admin-"));
  tempRoots.push(root);
  return root;
}

const recordOwnedPathForTransactionTest = () => true;

afterEach(() => {
  setIcaclsRunnerForTests(null);
  setPlatformForTests(null);
  resetHardenedStateForTests();
  if (originalOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalOpenCodexHome;
  if (originalAdminToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = originalAdminToken;
  if (originalAdminTokenFile === undefined) delete process.env.OCX_ADMIN_TOKEN_FILE;
  else process.env.OCX_ADMIN_TOKEN_FILE = originalAdminTokenFile;
  if (originalUsername === undefined) delete process.env.USERNAME;
  else process.env.USERNAME = originalUsername;
  if (originalUserDomain === undefined) delete process.env.USERDOMAIN;
  else process.env.USERDOMAIN = originalUserDomain;
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("service management token delivery", () => {
  test("a fresh explicit install failure leaves no service token files behind", () => {
    const root = tempRoot();

    expect(() => withServiceTokenInstallTransaction(() => {
      throw new Error("platform install failed");
    }, {
      configDir: root,
      env: {
        OPENCODEX_API_AUTH_TOKEN: "fresh-data",
        OPENCODEX_ADMIN_AUTH_TOKEN: "fresh-admin",
      },
      platform: "linux",
      recordOwnedPath: recordOwnedPathForTransactionTest,
    })).toThrow(/platform install failed/);

    expect(existsSync(serviceApiTokenFilePath(root))).toBe(false);
    expect(existsSync(serviceAdminTokenFilePath(root))).toBe(false);
  });

  test("a failed explicit rotation restores both service token files byte-for-byte", () => {
    const root = tempRoot();
    const dataPath = serviceApiTokenFilePath(root);
    const adminPath = serviceAdminTokenFilePath(root);
    const originalData = Buffer.from(" original-data \r\n", "utf8");
    const originalAdmin = Buffer.from(" original-admin \n", "utf8");
    writeFileSync(dataPath, originalData);
    writeFileSync(adminPath, originalAdmin);

    expect(() => withServiceTokenInstallTransaction(() => {
      expect(readFileSync(dataPath, "utf8")).toBe("replacement-data\n");
      expect(readFileSync(adminPath, "utf8")).toBe("replacement-admin\n");
      throw new Error("platform install failed");
    }, {
      configDir: root,
      env: {
        OPENCODEX_API_AUTH_TOKEN: "replacement-data",
        OPENCODEX_ADMIN_AUTH_TOKEN: "replacement-admin",
      },
      platform: "linux",
      recordOwnedPath: recordOwnedPathForTransactionTest,
    })).toThrow(/platform install failed/);

    expect(readFileSync(dataPath)).toEqual(originalData);
    expect(readFileSync(adminPath)).toEqual(originalAdmin);
  });

  test("an asynchronous native-service failure restores both service token files", async () => {
    const root = tempRoot();
    const dataPath = serviceApiTokenFilePath(root);
    const adminPath = serviceAdminTokenFilePath(root);
    writeFileSync(dataPath, "original-data\n", "utf8");
    writeFileSync(adminPath, "original-admin\n", "utf8");

    await expect(withServiceTokenInstallTransactionAsync(async () => {
      await Promise.resolve();
      throw new Error("async platform install failed");
    }, {
      configDir: root,
      env: {
        OPENCODEX_API_AUTH_TOKEN: "replacement-data",
        OPENCODEX_ADMIN_AUTH_TOKEN: "replacement-admin",
      },
      platform: "linux",
      recordOwnedPath: recordOwnedPathForTransactionTest,
    })).rejects.toThrow(/async platform install failed/);

    expect(readFileSync(dataPath, "utf8")).toBe("original-data\n");
    expect(readFileSync(adminPath, "utf8")).toBe("original-admin\n");
  });

  test("a failed install restores a service admin token that the plan revoked", () => {
    const root = tempRoot();
    const adminPath = serviceAdminTokenFilePath(root);
    const originalAdmin = Buffer.from("admin-before-revocation\n", "utf8");
    writeFileSync(adminPath, originalAdmin);

    expect(() => withServiceTokenInstallTransaction(() => {
      expect(existsSync(adminPath)).toBe(false);
      throw new Error("platform install failed");
    }, {
      configDir: root,
      env: {},
      platform: "linux",
      recordOwnedPath: recordOwnedPathForTransactionTest,
    })).toThrow(/platform install failed/);

    expect(readFileSync(adminPath)).toEqual(originalAdmin);
  });

  test("an oversized admin plan cannot partially update the data service token", () => {
    const root = tempRoot();
    const dataPath = serviceApiTokenFilePath(root);
    const adminPath = serviceAdminTokenFilePath(root);
    writeFileSync(dataPath, "original-data\n", "utf8");
    writeFileSync(adminPath, "original-admin\n", "utf8");
    let platformCalled = false;

    expect(() => withServiceTokenInstallTransaction(() => {
      platformCalled = true;
    }, {
      configDir: root,
      env: {
        OPENCODEX_API_AUTH_TOKEN: "replacement-data",
        OPENCODEX_ADMIN_AUTH_TOKEN: "\u00e9".repeat(256),
      },
      platform: "linux",
      recordOwnedPath: recordOwnedPathForTransactionTest,
    })).toThrow(/512 UTF-8 bytes/);

    expect(platformCalled).toBe(false);
    expect(readFileSync(dataPath, "utf8")).toBe("original-data\n");
    expect(readFileSync(adminPath, "utf8")).toBe("original-admin\n");
  });

  test("a trailing newline in the raw data token is rejected before any install mutation", () => {
    const root = tempRoot();
    const dataPath = serviceApiTokenFilePath(root);
    const adminPath = serviceAdminTokenFilePath(root);
    writeFileSync(dataPath, "original-data\n", "utf8");
    writeFileSync(adminPath, "original-admin\n", "utf8");
    let platformCalled = false;

    expect(() => withServiceTokenInstallTransaction(() => {
      platformCalled = true;
    }, {
      configDir: root,
      env: {
        OPENCODEX_API_AUTH_TOKEN: "replacement-data\r\n",
        OPENCODEX_ADMIN_AUTH_TOKEN: "replacement-admin",
      },
      platform: "linux",
      recordOwnedPath: recordOwnedPathForTransactionTest,
    })).toThrow(/OPENCODEX_API_AUTH_TOKEN cannot contain CR, LF, or NUL/);

    expect(platformCalled).toBe(false);
    expect(readFileSync(dataPath, "utf8")).toBe("original-data\n");
    expect(readFileSync(adminPath, "utf8")).toBe("original-admin\n");
  });

  test("an embedded newline in the raw data token is rejected before any install mutation", () => {
    const root = tempRoot();
    const dataPath = serviceApiTokenFilePath(root);
    const adminPath = serviceAdminTokenFilePath(root);
    writeFileSync(dataPath, "original-data\n", "utf8");
    writeFileSync(adminPath, "original-admin\n", "utf8");
    let platformCalled = false;

    expect(() => withServiceTokenInstallTransaction(() => {
      platformCalled = true;
    }, {
      configDir: root,
      env: {
        OPENCODEX_API_AUTH_TOKEN: "replacement\ndata",
        OPENCODEX_ADMIN_AUTH_TOKEN: "replacement-admin",
      },
      platform: "linux",
      recordOwnedPath: recordOwnedPathForTransactionTest,
    })).toThrow(/OPENCODEX_API_AUTH_TOKEN cannot contain CR, LF, or NUL/);

    expect(platformCalled).toBe(false);
    expect(readFileSync(dataPath, "utf8")).toBe("original-data\n");
    expect(readFileSync(adminPath, "utf8")).toBe("original-admin\n");
  });

  test("a NUL in the raw data token is rejected before any install mutation", () => {
    const root = tempRoot();
    const dataPath = serviceApiTokenFilePath(root);
    const adminPath = serviceAdminTokenFilePath(root);
    writeFileSync(dataPath, "original-data\n", "utf8");
    writeFileSync(adminPath, "original-admin\n", "utf8");
    let platformCalled = false;

    expect(() => withServiceTokenInstallTransaction(() => {
      platformCalled = true;
    }, {
      configDir: root,
      env: {
        OPENCODEX_API_AUTH_TOKEN: "replacement\0data",
        OPENCODEX_ADMIN_AUTH_TOKEN: "replacement-admin",
      },
      platform: "linux",
      recordOwnedPath: recordOwnedPathForTransactionTest,
    })).toThrow(/OPENCODEX_API_AUTH_TOKEN cannot contain CR, LF, or NUL/);

    expect(platformCalled).toBe(false);
    expect(readFileSync(dataPath, "utf8")).toBe("original-data\n");
    expect(readFileSync(adminPath, "utf8")).toBe("original-admin\n");
  });

  test("control-only raw data tokens are rejected instead of revoking existing tokens", () => {
    for (const rawToken of ["\t", "\x01"]) {
      const root = tempRoot();
      const dataPath = serviceApiTokenFilePath(root);
      const adminPath = serviceAdminTokenFilePath(root);
      writeFileSync(dataPath, "original-data\n", "utf8");
      writeFileSync(adminPath, "original-admin\n", "utf8");
      let platformCalled = false;

      expect(() => withServiceTokenInstallTransaction(() => {
        platformCalled = true;
      }, {
        configDir: root,
        env: {
          OPENCODEX_API_AUTH_TOKEN: rawToken,
          OPENCODEX_ADMIN_AUTH_TOKEN: "replacement-admin",
        },
        platform: "linux",
        recordOwnedPath: recordOwnedPathForTransactionTest,
      })).toThrow(/ASCII control characters/);

      expect(platformCalled).toBe(false);
      expect(readFileSync(dataPath, "utf8")).toBe("original-data\n");
      expect(readFileSync(adminPath, "utf8")).toBe("original-admin\n");
    }
  });

  test("a non-empty whitespace-only data token is rejected instead of revoking existing tokens", () => {
    const root = tempRoot();
    const dataPath = serviceApiTokenFilePath(root);
    const adminPath = serviceAdminTokenFilePath(root);
    writeFileSync(dataPath, "original-data\n", "utf8");
    writeFileSync(adminPath, "original-admin\n", "utf8");
    let platformCalled = false;

    expect(() => withServiceTokenInstallTransaction(() => {
      platformCalled = true;
    }, {
      configDir: root,
      env: {
        OPENCODEX_API_AUTH_TOKEN: "   ",
        OPENCODEX_ADMIN_AUTH_TOKEN: "replacement-admin",
      },
      platform: "linux",
      recordOwnedPath: recordOwnedPathForTransactionTest,
    })).toThrow(/cannot be whitespace-only/);

    expect(platformCalled).toBe(false);
    expect(readFileSync(dataPath, "utf8")).toBe("original-data\n");
    expect(readFileSync(adminPath, "utf8")).toBe("original-admin\n");
  });

  test("an explicitly empty data token keeps the existing revoke behavior", () => {
    const root = tempRoot();
    const dataPath = serviceApiTokenFilePath(root);
    const adminPath = serviceAdminTokenFilePath(root);
    writeFileSync(dataPath, "original-data\n", "utf8");
    let platformCalled = false;

    withServiceTokenInstallTransaction(() => {
      platformCalled = true;
      expect(() => readFileSync(dataPath, "utf8")).toThrow();
    }, {
      configDir: root,
      env: {
        OPENCODEX_API_AUTH_TOKEN: "",
        OPENCODEX_ADMIN_AUTH_TOKEN: "replacement-admin",
      },
      platform: "linux",
      recordOwnedPath: recordOwnedPathForTransactionTest,
    });

    expect(platformCalled).toBe(true);
    expect(() => readFileSync(dataPath, "utf8")).toThrow();
    expect(readFileSync(adminPath, "utf8")).toBe("replacement-admin\n");
  });

  test("a long single-line data token remains supported", () => {
    const root = tempRoot();
    const dataPath = serviceApiTokenFilePath(root);
    const longToken = "x".repeat(4096);
    let platformCalled = false;

    withServiceTokenInstallTransaction(() => {
      platformCalled = true;
      expect(readFileSync(dataPath, "utf8")).toBe(`${longToken}\n`);
    }, {
      configDir: root,
      env: {
        OPENCODEX_API_AUTH_TOKEN: longToken,
        OPENCODEX_ADMIN_AUTH_TOKEN: "replacement-admin",
      },
      platform: "linux",
      recordOwnedPath: recordOwnedPathForTransactionTest,
    });

    expect(platformCalled).toBe(true);
    expect(readFileSync(dataPath, "utf8")).toBe(`${longToken}\n`);
  });

  test("an admin ACL failure rolls back an already-updated data service token", () => {
    const root = tempRoot();
    const dataPath = serviceApiTokenFilePath(root);
    const adminPath = serviceAdminTokenFilePath(root);
    writeFileSync(dataPath, "original-data\n", "utf8");
    writeFileSync(adminPath, "original-admin\n", "utf8");
    process.env.USERNAME = "ocx-test-user";
    process.env.USERDOMAIN = "OCX-TEST";
    setPlatformForTests("win32");
    resetHardenedStateForTests();
    setIcaclsRunnerForTests(args => (args[0] ?? "").includes("service-admin-token.tmp")
      ? { success: false, exitCode: null, timedOut: true, stdout: "" }
      : { success: true, exitCode: 0, timedOut: false, stdout: "" });

    expect(() => withServiceTokenInstallTransaction(() => {
      throw new Error("platform should not run");
    }, {
      configDir: root,
      env: {
        OPENCODEX_API_AUTH_TOKEN: "replacement-data",
        OPENCODEX_ADMIN_AUTH_TOKEN: "replacement-admin",
      },
      platform: "win32",
      recordOwnedPath: recordOwnedPathForTransactionTest,
    })).toThrow(/management service token file ACL hardening did not complete/);

    expect(readFileSync(dataPath, "utf8")).toBe("original-data\n");
    expect(readFileSync(adminPath, "utf8")).toBe("original-admin\n");
  });

  test("a service-file-only reinstall preserves the current admin token and definition path", () => {
    const root = tempRoot();
    const adminPath = serviceAdminTokenFilePath(root);
    const originalAdmin = Buffer.from("service-admin-for-update\n", "utf8");
    writeFileSync(adminPath, originalAdmin);
    const env: Record<string, string | undefined> = {
      OPENCODEX_API_AUTH_TOKEN: "service-data-for-update",
      OCX_ADMIN_TOKEN_FILE: join(root, ".", "service-admin-token"),
    };

    const state = withServiceTokenInstallTransaction(definitionState => definitionState, {
      configDir: root,
      env,
      platform: "linux",
      recordOwnedPath: recordOwnedPathForTransactionTest,
    });

    expect(state.adminTokenFile).toBe(adminPath);
    expect(readFileSync(adminPath)).toEqual(originalAdmin);
    expect(env.OPENCODEX_ADMIN_AUTH_TOKEN).toBeUndefined();
  });

  test("a failed service-file-only reinstall preserves the current admin token byte-for-byte", () => {
    const root = tempRoot();
    const adminPath = serviceAdminTokenFilePath(root);
    const originalAdmin = Buffer.from(" service-admin-for-update \n", "utf8");
    writeFileSync(adminPath, originalAdmin);
    const env: Record<string, string | undefined> = {
      OPENCODEX_API_AUTH_TOKEN: "service-data-for-update",
      OCX_ADMIN_TOKEN_FILE: adminPath,
    };

    expect(() => withServiceTokenInstallTransaction(() => {
      throw new Error("platform install failed");
    }, {
      configDir: root,
      env,
      platform: "linux",
      recordOwnedPath: recordOwnedPathForTransactionTest,
    })).toThrow(/platform install failed/);

    expect(readFileSync(adminPath)).toEqual(originalAdmin);
    expect(env.OPENCODEX_ADMIN_AUTH_TOKEN).toBeUndefined();
  });

  test("a preserved service admin token ACL timeout blocks reinstall before any data update", () => {
    const root = tempRoot();
    const dataPath = serviceApiTokenFilePath(root);
    const adminPath = serviceAdminTokenFilePath(root);
    writeFileSync(dataPath, "original-data\n", "utf8");
    writeFileSync(adminPath, "service-admin-for-update\n", "utf8");
    process.env.USERNAME = "ocx-test-user";
    process.env.USERDOMAIN = "OCX-TEST";
    setPlatformForTests("win32");
    resetHardenedStateForTests();
    setIcaclsRunnerForTests(args => args[0] === adminPath
      ? { success: false, exitCode: null, timedOut: true, stdout: "" }
      : { success: true, exitCode: 0, timedOut: false, stdout: "" });
    let platformCalled = false;

    expect(() => withServiceTokenInstallTransaction(() => {
      platformCalled = true;
    }, {
      configDir: root,
      env: {
        OPENCODEX_API_AUTH_TOKEN: "replacement-data",
        OCX_ADMIN_TOKEN_FILE: adminPath,
      },
      platform: "win32",
      recordOwnedPath: recordOwnedPathForTransactionTest,
    })).toThrow(/preserved management service token file ACL hardening did not complete/);

    expect(platformCalled).toBe(false);
    expect(readFileSync(dataPath, "utf8")).toBe("original-data\n");
    expect(readFileSync(adminPath, "utf8")).toBe("service-admin-for-update\n");
  });

  test("a reinstall rejects an admin token pointer outside the current config directory", () => {
    const root = tempRoot();
    const externalRoot = tempRoot();
    const dataPath = serviceApiTokenFilePath(root);
    const externalAdminPath = serviceAdminTokenFilePath(externalRoot);
    writeFileSync(dataPath, "original-data\n", "utf8");
    writeFileSync(externalAdminPath, "external-admin\n", "utf8");

    expect(() => withServiceTokenInstallTransaction(() => {
      throw new Error("platform should not run");
    }, {
      configDir: root,
      env: {
        OPENCODEX_API_AUTH_TOKEN: "replacement-data",
        OCX_ADMIN_TOKEN_FILE: externalAdminPath,
      },
      platform: "linux",
      recordOwnedPath: recordOwnedPathForTransactionTest,
    })).toThrow(/must resolve to the current service-admin-token/);

    expect(readFileSync(dataPath, "utf8")).toBe("original-data\n");
    expect(readFileSync(externalAdminPath, "utf8")).toBe("external-admin\n");
  });

  test("a reinstall rejects the current service admin pointer when its file is invalid", () => {
    const root = tempRoot();
    const dataPath = serviceApiTokenFilePath(root);
    const adminPath = serviceAdminTokenFilePath(root);
    writeFileSync(dataPath, "original-data\n", "utf8");
    writeFileSync(adminPath, " \n", "utf8");

    expect(() => withServiceTokenInstallTransaction(() => {
      throw new Error("platform should not run");
    }, {
      configDir: root,
      env: {
        OPENCODEX_API_AUTH_TOKEN: "replacement-data",
        OCX_ADMIN_TOKEN_FILE: adminPath,
      },
      platform: "linux",
      recordOwnedPath: recordOwnedPathForTransactionTest,
    })).toThrow(/does not reference a valid current service-admin-token/);

    expect(readFileSync(dataPath, "utf8")).toBe("original-data\n");
    expect(readFileSync(adminPath, "utf8")).toBe(" \n");
  });

  test("a reinstall rejects a preserved service admin token with an embedded line break", () => {
    const root = tempRoot();
    const dataPath = serviceApiTokenFilePath(root);
    const adminPath = serviceAdminTokenFilePath(root);
    writeFileSync(dataPath, "original-data\n", "utf8");
    writeFileSync(adminPath, "admin-line-one\nadmin-line-two\n", "utf8");

    expect(() => withServiceTokenInstallTransaction(() => {
      throw new Error("platform should not run");
    }, {
      configDir: root,
      env: {
        OPENCODEX_API_AUTH_TOKEN: "replacement-data",
        OCX_ADMIN_TOKEN_FILE: adminPath,
      },
      platform: "linux",
      recordOwnedPath: recordOwnedPathForTransactionTest,
    })).toThrow(/does not reference a valid current service-admin-token/);

    expect(readFileSync(dataPath, "utf8")).toBe("original-data\n");
    expect(readFileSync(adminPath, "utf8")).toBe("admin-line-one\nadmin-line-two\n");
  });

  test("all four service definitions use transaction state instead of re-reading file existence", () => {
    const root = tempRoot();
    const adminPath = serviceAdminTokenFilePath(root);
    process.env.OPENCODEX_HOME = root;
    process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "definition-admin";

    const definitions = withServiceTokenInstallTransaction(state => {
      const payload = readFileSync(adminPath);
      unlinkSync(adminPath);
      try {
        return [
          buildPlist(state),
          buildUnit(state),
          buildWindowsServiceScript(
            { bun: "C:\\ocx\\bun.exe", cli: "C:\\ocx\\cli.ts" },
            10100,
            state,
          ),
          buildWinswXml(
            { bun: "C:\\ocx\\bun.exe", cli: "C:\\ocx\\cli.ts" },
            { USERDOMAIN: "OCX", USERNAME: "tester", OPENCODEX_HOME: root },
            10100,
            state,
          ),
        ];
      } finally {
        writeFileSync(adminPath, payload, { mode: 0o600 });
      }
    }, {
      configDir: root,
      env: {
        OPENCODEX_API_AUTH_TOKEN: "definition-data",
        OPENCODEX_ADMIN_AUTH_TOKEN: "definition-admin",
      },
      platform: "linux",
      recordOwnedPath: recordOwnedPathForTransactionTest,
    });

    for (const definition of definitions) {
      expect(definition).toContain("OCX_ADMIN_TOKEN_FILE");
      const escapedAdminPath = adminPath.replace(/\\/g, "\\\\");
      expect(definition.includes(adminPath) || definition.includes(escapedAdminPath)).toBe(true);
    }
  });

  test("all four service definitions keep a revoked admin token omitted despite file reappearance", () => {
    const root = tempRoot();
    const adminPath = serviceAdminTokenFilePath(root);
    process.env.OPENCODEX_HOME = root;

    const definitions = withServiceTokenInstallTransaction(state => {
      expect(state.adminTokenFile).toBeNull();
      writeFileSync(adminPath, "unexpected-admin\n", { mode: 0o600 });
      try {
        return [
          buildPlist(state),
          buildUnit(state),
          buildWindowsServiceScript(
            { bun: "C:\\ocx\\bun.exe", cli: "C:\\ocx\\cli.ts" },
            10100,
            state,
          ),
          buildWinswXml(
            { bun: "C:\\ocx\\bun.exe", cli: "C:\\ocx\\cli.ts" },
            { USERDOMAIN: "OCX", USERNAME: "tester", OPENCODEX_HOME: root },
            10100,
            state,
          ),
        ];
      } finally {
        unlinkSync(adminPath);
      }
    }, {
      configDir: root,
      env: {},
      platform: "linux",
      recordOwnedPath: recordOwnedPathForTransactionTest,
    });

    for (const definition of definitions) {
      expect(definition).not.toContain("OCX_ADMIN_TOKEN_FILE");
    }
  });

  test("a rollback hardening failure is disclosed without hiding the platform failure", () => {
    const root = tempRoot();
    writeFileSync(serviceApiTokenFilePath(root), "original-data\n", "utf8");
    writeFileSync(serviceAdminTokenFilePath(root), "original-admin\n", "utf8");
    process.env.USERNAME = "ocx-test-user";
    process.env.USERDOMAIN = "OCX-TEST";
    setPlatformForTests("win32");
    resetHardenedStateForTests();
    setIcaclsRunnerForTests(args => (args[0] ?? "").includes(".restore.")
      ? { success: false, exitCode: null, timedOut: true, stdout: "" }
      : { success: true, exitCode: 0, timedOut: false, stdout: "" });

    expect(() => withServiceTokenInstallTransaction(() => {
      throw new Error("platform install failed");
    }, {
      configDir: root,
      env: {
        OPENCODEX_API_AUTH_TOKEN: "replacement-data",
        OPENCODEX_ADMIN_AUTH_TOKEN: "replacement-admin",
      },
      platform: "win32",
      recordOwnedPath: recordOwnedPathForTransactionTest,
    })).toThrow(/platform install failed; service token rollback also failed/);
  });

  test("startup loading keeps the data service token behavior without exporting the admin token", () => {
    const root = tempRoot();
    const dataPath = serviceApiTokenFilePath(root);
    const adminPath = serviceAdminTokenFilePath(root);
    writeFileSync(dataPath, "service-data\n", "utf8");
    writeFileSync(adminPath, "service-admin\n", "utf8");
    const env: Record<string, string | undefined> = {
      OCX_API_TOKEN_FILE: dataPath,
      OCX_ADMIN_TOKEN_FILE: adminPath,
    };

    loadServiceTokensIntoEnv(env, root);

    expect(env.OPENCODEX_API_AUTH_TOKEN).toBe("service-data");
    expect(env.OPENCODEX_ADMIN_AUTH_TOKEN).toBeUndefined();
  });

  test("a data-token ACL timeout preserves the previous token and removes the unsecured replacement", () => {
    const root = tempRoot();
    const tokenPath = serviceApiTokenFilePath(root);
    writeFileSync(tokenPath, "previous-data\n", "utf8");
    process.env.USERNAME = "ocx-test-user";
    process.env.USERDOMAIN = "OCX-TEST";
    setPlatformForTests("win32");
    resetHardenedStateForTests();
    setIcaclsRunnerForTests(args => args[0] === root
      ? { success: true, exitCode: 0, timedOut: false, stdout: "" }
      : { success: false, exitCode: null, timedOut: true, stdout: "" });

    expect(() => writeServiceApiTokenFile({
      configDir: root,
      env: { OPENCODEX_API_AUTH_TOKEN: "replacement-data" },
      platform: "win32",
    })).toThrow(/ACL hardening did not complete/);
    expect(readFileSync(tokenPath, "utf8")).toBe("previous-data\n");
    expect(readdirSync(root).filter(name => name.includes("service-api-token.tmp"))).toEqual([]);
  });

  test("an install without an environment data token removes a stale service token", () => {
    const root = tempRoot();
    const tokenPath = serviceApiTokenFilePath(root);
    writeFileSync(tokenPath, "stale-data\n", "utf8");

    expect(writeServiceApiTokenFile({ configDir: root, env: {}, platform: "linux" })).toBeNull();
    expect(existsSync(tokenPath)).toBe(false);
  });

  test("an install aborts when a stale service data token cannot be removed", () => {
    const root = tempRoot();
    const tokenPath = serviceApiTokenFilePath(root);
    mkdirSync(tokenPath);

    expect(() => writeServiceApiTokenFile({
      configDir: root,
      env: {},
      platform: "linux",
    })).toThrow(/stale data service token could not be removed/);
    expect(existsSync(tokenPath)).toBe(true);
  });

  test("an install without an explicit admin token removes a stale service admin token", () => {
    const root = tempRoot();
    const tokenPath = serviceAdminTokenFilePath(root);
    writeFileSync(tokenPath, "stale-admin\n", "utf8");

    expect(writeServiceAdminTokenFile({
      configDir: root,
      env: {},
      platform: "linux",
    })).toBeNull();
    expect(existsSync(tokenPath)).toBe(false);
  });

  test("an install aborts when a stale service admin token cannot be removed", () => {
    const root = tempRoot();
    const tokenPath = serviceAdminTokenFilePath(root);
    mkdirSync(tokenPath);

    expect(() => writeServiceAdminTokenFile({
      configDir: root,
      env: {},
      platform: "linux",
    })).toThrow(/stale management service token could not be removed/);
    expect(existsSync(tokenPath)).toBe(true);
  });

  test("fails closed and removes the token file when icacls times out without throwing", () => {
    const root = tempRoot();
    const tokenPath = serviceAdminTokenFilePath(root);
    process.env.USERNAME = "ocx-test-user";
    process.env.USERDOMAIN = "OCX-TEST";
    setPlatformForTests("win32");
    resetHardenedStateForTests();
    setIcaclsRunnerForTests(args => args[0] === root
      ? { success: true, exitCode: 0, timedOut: false, stdout: "" }
      : { success: false, exitCode: null, timedOut: true, stdout: "" });

    expect(() => writeServiceAdminTokenFile({
      configDir: root,
      env: { OPENCODEX_ADMIN_AUTH_TOKEN: "admin-for-service" },
      platform: "win32",
    })).toThrow(/ACL hardening did not complete/);
    expect(existsSync(tokenPath)).toBe(false);
  });

  test("an ACL timeout preserves the previous token and removes the unsecured replacement", () => {
    const root = tempRoot();
    const tokenPath = serviceAdminTokenFilePath(root);
    writeFileSync(tokenPath, "previous-admin\n", "utf8");
    process.env.USERNAME = "ocx-test-user";
    process.env.USERDOMAIN = "OCX-TEST";
    setPlatformForTests("win32");
    resetHardenedStateForTests();
    setIcaclsRunnerForTests(args => args[0] === root
      ? { success: true, exitCode: 0, timedOut: false, stdout: "" }
      : { success: false, exitCode: null, timedOut: true, stdout: "" });

    expect(() => writeServiceAdminTokenFile({
      configDir: root,
      env: { OPENCODEX_ADMIN_AUTH_TOKEN: "replacement-admin" },
      platform: "win32",
    })).toThrow(/ACL hardening did not complete/);
    expect(readFileSync(tokenPath, "utf8")).toBe("previous-admin\n");
    expect(readdirSync(root).filter(name => name.includes("service-admin-token.tmp"))).toEqual([]);
  });

  test("replaces an existing token only after the secured replacement is ready", () => {
    const root = tempRoot();
    const tokenPath = serviceAdminTokenFilePath(root);
    writeFileSync(tokenPath, "previous-admin\n", "utf8");

    expect(writeServiceAdminTokenFile({
      configDir: root,
      env: { OPENCODEX_ADMIN_AUTH_TOKEN: "replacement-admin" },
      platform: "linux",
    })).toBe(tokenPath);
    expect(readFileSync(tokenPath, "utf8")).toBe("replacement-admin\n");
    expect(readdirSync(root).filter(name => name.includes("service-admin-token.tmp"))).toEqual([]);
  });

  test("rejects a service admin token over 512 UTF-8 bytes before writing it", () => {
    const root = tempRoot();
    const oversized = "\u00e9".repeat(256) + "x";

    expect(() => writeServiceAdminTokenFile({
      configDir: root,
      env: { OPENCODEX_ADMIN_AUTH_TOKEN: oversized },
      platform: "linux",
    })).toThrow(/512 UTF-8 bytes/);
    expect(existsSync(serviceAdminTokenFilePath(root))).toBe(false);
  });

  test("rejects a 512-byte service admin token because the serialized file adds a newline", () => {
    const root = tempRoot();
    const boundary = "\u00e9".repeat(256);

    expect(() => writeServiceAdminTokenFile({
      configDir: root,
      env: { OPENCODEX_ADMIN_AUTH_TOKEN: boundary },
      platform: "linux",
    })).toThrow(/512 UTF-8 bytes/);
    expect(existsSync(serviceAdminTokenFilePath(root))).toBe(false);
  });

  test("accepts a 511-byte service admin token whose serialized file is exactly 512 bytes", () => {
    const root = tempRoot();
    const boundary = "\u00e9".repeat(255) + "x";
    const tokenPath = serviceAdminTokenFilePath(root);

    expect(writeServiceAdminTokenFile({
      configDir: root,
      env: { OPENCODEX_ADMIN_AUTH_TOKEN: boundary },
      platform: "linux",
    })).toBe(tokenPath);
    const serialized = readFileSync(tokenPath);
    expect(serialized.byteLength).toBe(512);
    expect(serialized.toString("utf8")).toBe(`${boundary}\n`);
  });

  test("keeps legacy nonempty config directories usable without claiming ownership", () => {
    const root = tempRoot();
    writeFileSync(join(root, "legacy-config.json"), "{}\n", "utf8");

    expect(writeServiceAdminTokenFile({
      configDir: root,
      env: { OPENCODEX_ADMIN_AUTH_TOKEN: "legacy-admin" },
      platform: "linux",
    })).toBe(serviceAdminTokenFilePath(root));
    expect(readFileSync(serviceAdminTokenFilePath(root), "utf8")).toBe("legacy-admin\n");
    expect(existsSync(join(root, ".opencodex-owner.json"))).toBe(false);
    expect(existsSync(join(root, ".opencodex-uninstall.json"))).toBe(false);
  });

  test("fails closed when a valid ownership manifest cannot register the service token", () => {
    const root = tempRoot();
    expect(recordOwnedConfigPath(root, join(root, "seed.json"))).toBe(true);

    expect(() => writeServiceAdminTokenFile({
      configDir: root,
      env: { OPENCODEX_ADMIN_AUTH_TOKEN: "owned-admin" },
      platform: "linux",
      recordOwnedPath: () => false,
    })).toThrow(/ownership manifest/);
    expect(existsSync(serviceAdminTokenFilePath(root))).toBe(false);
  });

  test("fails closed when ownership registration fails for a fresh directory", () => {
    const root = tempRoot();

    expect(() => writeServiceAdminTokenFile({
      configDir: root,
      env: { OPENCODEX_ADMIN_AUTH_TOKEN: "fresh-admin" },
      platform: "linux",
      recordOwnedPath: () => false,
    })).toThrow(/ownership manifest/);
    expect(existsSync(serviceAdminTokenFilePath(root))).toBe(false);
  });

  test("keeps environment, primary file, and service file precedence", () => {
    const root = tempRoot();
    const primary = `ocx_admin_${"a".repeat(43)}`;
    writeFileSync(adminApiTokenFilePath(root), `${primary}\n`, "utf8");
    writeFileSync(serviceAdminTokenFilePath(root), "service-admin\n", "utf8");

    expect(configuredAdminToken(root, {
      OPENCODEX_ADMIN_AUTH_TOKEN: "environment-admin",
      OCX_ADMIN_TOKEN_FILE: serviceAdminTokenFilePath(root),
    })).toBe("environment-admin");
    expect(configuredAdminToken(root, {
      OCX_ADMIN_TOKEN_FILE: serviceAdminTokenFilePath(root),
    })).toBe(primary);
    unlinkSync(adminApiTokenFilePath(root));
    expect(configuredAdminToken(root, {
      OCX_ADMIN_TOKEN_FILE: serviceAdminTokenFilePath(root),
    })).toBe("service-admin");
  });

  test("server initialization keeps explicit environment, primary file, and service file precedence", () => {
    const config = () => ({
      port: 10100,
      hostname: "0.0.0.0",
      defaultProvider: "test",
      providers: {},
    } as OcxConfig);

    const explicitRoot = tempRoot();
    mkdirSync(adminApiTokenFilePath(explicitRoot));
    writeFileSync(serviceAdminTokenFilePath(explicitRoot), "service-explicit\n", "utf8");
    process.env.OPENCODEX_HOME = explicitRoot;
    process.env.OCX_ADMIN_TOKEN_FILE = serviceAdminTokenFilePath(explicitRoot);
    process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "explicit-admin";
    expect(initializeManagementAuthState(config())).toMatchObject({ available: true, token: "explicit-admin" });

    const primaryRoot = tempRoot();
    const primary = `ocx_admin_${"p".repeat(43)}`;
    writeFileSync(adminApiTokenFilePath(primaryRoot), `${primary}\n`, "utf8");
    writeFileSync(serviceAdminTokenFilePath(primaryRoot), "service-primary\n", "utf8");
    process.env.OPENCODEX_HOME = primaryRoot;
    process.env.OCX_ADMIN_TOKEN_FILE = serviceAdminTokenFilePath(primaryRoot);
    delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
    expect(initializeManagementAuthState(config())).toMatchObject({ available: true, token: primary });

    const serviceRoot = tempRoot();
    writeFileSync(serviceAdminTokenFilePath(serviceRoot), "service-only\n", "utf8");
    process.env.OPENCODEX_HOME = serviceRoot;
    process.env.OCX_ADMIN_TOKEN_FILE = serviceAdminTokenFilePath(serviceRoot);
    expect(initializeManagementAuthState(config())).toMatchObject({ available: true, token: "service-only" });
  });

  test("service startup keeps the primary admin file ahead of the service delivery file", () => {
    const root = tempRoot();
    const primary = `ocx_admin_${"b".repeat(43)}`;
    writeFileSync(adminApiTokenFilePath(root), `${primary}\n`, "utf8");
    writeFileSync(serviceAdminTokenFilePath(root), "service-admin\n", "utf8");
    const env: Record<string, string | undefined> = {
      OCX_ADMIN_TOKEN_FILE: serviceAdminTokenFilePath(root),
    };

    loadServiceTokensIntoEnv(env, root);

    expect(env.OPENCODEX_ADMIN_AUTH_TOKEN).toBeUndefined();
    expect(configuredAdminToken(root, env)).toBe(primary);
  });

  test("service startup preserves an explicit token without loading the service token into the environment", () => {
    const root = tempRoot();
    const servicePath = serviceAdminTokenFilePath(root);
    writeFileSync(servicePath, "service-admin\n", "utf8");
    const explicitEnv: Record<string, string | undefined> = {
      OPENCODEX_ADMIN_AUTH_TOKEN: "explicit-admin",
      OCX_ADMIN_TOKEN_FILE: servicePath,
    };

    loadServiceTokensIntoEnv(explicitEnv, root);
    expect(explicitEnv.OPENCODEX_ADMIN_AUTH_TOKEN).toBe("explicit-admin");

    process.env.OPENCODEX_HOME = root;
    process.env.OCX_ADMIN_TOKEN_FILE = servicePath;
    delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
    loadServiceTokensIntoEnv(process.env, root);
    expect(process.env.OPENCODEX_ADMIN_AUTH_TOKEN).toBeUndefined();

    const state = initializeManagementAuthState({
      port: 10100,
      hostname: "0.0.0.0",
      defaultProvider: "test",
      providers: {},
    } as OcxConfig);
    expect(state).toMatchObject({ available: true, token: "service-admin" });
  });

  test("active service admin secrets stay isolated by config and failed reinitialization clears only one", () => {
    delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
    const rootA = tempRoot();
    const rootB = tempRoot();
    const secretA = "service-admin-without-prefix-a";
    const secretB = "service-admin-without-prefix-b";
    const configA = {
      port: 10100,
      hostname: "0.0.0.0",
      defaultProvider: "test",
      providers: {},
    } as OcxConfig;
    const configB = { ...configA } as OcxConfig;

    writeFileSync(serviceAdminTokenFilePath(rootA), `${secretA}\n`, "utf8");
    process.env.OPENCODEX_HOME = rootA;
    process.env.OCX_ADMIN_TOKEN_FILE = serviceAdminTokenFilePath(rootA);
    expect(initializeManagementAuthState(configA)).toMatchObject({ available: true, token: secretA });

    writeFileSync(serviceAdminTokenFilePath(rootB), `${secretB}\n`, "utf8");
    process.env.OPENCODEX_HOME = rootB;
    process.env.OCX_ADMIN_TOKEN_FILE = serviceAdminTokenFilePath(rootB);
    expect(initializeManagementAuthState(configB)).toMatchObject({ available: true, token: secretB });

    expect(isProxyAdmissionSecret(secretA, configA)).toBe(true);
    expect(isProxyAdmissionSecret(secretA, configB)).toBe(false);
    expect(isProxyAdmissionSecret(secretB, configB)).toBe(true);
    expect(isProxyAdmissionSecret(secretB, configA)).toBe(false);
    expect(() => validateForwardAdmissionCredential(
      new Headers({ authorization: `Bearer ${secretA}` }),
      configA,
    )).toThrow("OpenCodex admission credentials cannot be forwarded upstream");

    mkdirSync(adminApiTokenFilePath(rootB));
    expect(initializeManagementAuthState(configB).available).toBe(false);
    expect(isProxyAdmissionSecret(secretB, configB)).toBe(false);
    expect(isProxyAdmissionSecret(secretA, configA)).toBe(true);
  });

  test("service startup does not fall back when the primary admin path is invalid", () => {
    const root = tempRoot();
    mkdirSync(adminApiTokenFilePath(root));
    writeFileSync(serviceAdminTokenFilePath(root), "service-admin\n", "utf8");
    process.env.OPENCODEX_HOME = root;
    process.env.OCX_ADMIN_TOKEN_FILE = serviceAdminTokenFilePath(root);
    delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;

    loadServiceTokensIntoEnv(process.env, root);
    const state = initializeManagementAuthState({
      port: 10100,
      hostname: "0.0.0.0",
      defaultProvider: "test",
      providers: {},
    } as OcxConfig);

    expect(process.env.OPENCODEX_ADMIN_AUTH_TOKEN).toBeUndefined();
    expect(state.available).toBe(false);
    expect(readFileSync(serviceAdminTokenFilePath(root), "utf8")).toBe("service-admin\n");
  });

  test("service startup does not follow or fall back from a primary admin symlink", () => {
    const root = tempRoot();
    const target = join(root, "outside-token-directory");
    mkdirSync(target);
    symlinkSync(target, adminApiTokenFilePath(root), process.platform === "win32" ? "junction" : "dir");
    writeFileSync(serviceAdminTokenFilePath(root), "service-admin\n", "utf8");
    process.env.OPENCODEX_HOME = root;
    process.env.OCX_ADMIN_TOKEN_FILE = serviceAdminTokenFilePath(root);
    delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;

    const state = initializeManagementAuthState({
      port: 10100,
      hostname: "0.0.0.0",
      defaultProvider: "test",
      providers: {},
    } as OcxConfig);

    expect(state.available).toBe(false);
    expect(readFileSync(serviceAdminTokenFilePath(root), "utf8")).toBe("service-admin\n");
  });

  test("service startup cannot bypass primary-file ACL timeout handling", () => {
    const root = tempRoot();
    const primary = `ocx_admin_${"d".repeat(43)}`;
    const primaryPath = adminApiTokenFilePath(root);
    writeFileSync(primaryPath, `${primary}\n`, "utf8");
    writeFileSync(serviceAdminTokenFilePath(root), "service-admin\n", "utf8");
    process.env.OPENCODEX_HOME = root;
    process.env.OCX_ADMIN_TOKEN_FILE = serviceAdminTokenFilePath(root);
    delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
    const hardenedTargets: string[] = [];

    loadServiceTokensIntoEnv(process.env, root);
    const state = initializeManagementAuthState({
      port: 10100,
      hostname: "0.0.0.0",
      defaultProvider: "test",
      providers: {},
    } as OcxConfig, {
      hardenSecretDir: target => {
        hardenedTargets.push(target);
        return { ok: true };
      },
      hardenSecretPath: target => {
        hardenedTargets.push(target);
        return target === primaryPath
          ? { ok: false, diagnostics: "icacls file hardening timed out" }
          : { ok: true };
      },
    });

    expect(process.env.OPENCODEX_ADMIN_AUTH_TOKEN).toBeUndefined();
    expect(hardenedTargets).toContain(primaryPath);
    expect(state.available).toBe(false);
  });

  test("a service admin token ACL timeout closes management without deleting or exporting the token", () => {
    const root = tempRoot();
    const servicePath = serviceAdminTokenFilePath(root);
    const secret = "service-admin-without-prefix";
    writeFileSync(servicePath, `${secret}\n`, "utf8");
    process.env.OPENCODEX_HOME = root;
    process.env.OCX_ADMIN_TOKEN_FILE = servicePath;
    delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
    const hardenedTargets: string[] = [];

    loadServiceTokensIntoEnv(process.env, root);
    const state = initializeManagementAuthState({
      port: 10100,
      hostname: "0.0.0.0",
      defaultProvider: "test",
      providers: {},
    } as OcxConfig, {
      hardenSecretDir: target => {
        hardenedTargets.push(target);
        return { ok: true };
      },
      hardenSecretPath: target => {
        hardenedTargets.push(target);
        return target === servicePath
          ? { ok: false, diagnostics: "icacls file hardening timed out" }
          : { ok: true };
      },
    });

    expect(state.available).toBe(false);
    expect(process.env.OPENCODEX_ADMIN_AUTH_TOKEN).toBeUndefined();
    expect(readFileSync(servicePath, "utf8")).toBe(`${secret}\n`);
    expect(hardenedTargets).toContain(root);
    expect(hardenedTargets).toContain(servicePath);
  });

  test("a service admin token directory closes management without generating a primary token", () => {
    const root = tempRoot();
    const servicePath = serviceAdminTokenFilePath(root);
    mkdirSync(servicePath);
    process.env.OPENCODEX_HOME = root;
    process.env.OCX_ADMIN_TOKEN_FILE = servicePath;
    delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;

    const state = initializeManagementAuthState({
      port: 10100,
      hostname: "0.0.0.0",
      defaultProvider: "test",
      providers: {},
    } as OcxConfig);

    expect(state.available).toBe(false);
    expect(existsSync(adminApiTokenFilePath(root))).toBe(false);
  });

  test("an oversized service admin token closes management without replacing the file", () => {
    const root = tempRoot();
    const servicePath = serviceAdminTokenFilePath(root);
    const oversized = "x".repeat(513);
    writeFileSync(servicePath, oversized, "utf8");
    process.env.OPENCODEX_HOME = root;
    process.env.OCX_ADMIN_TOKEN_FILE = servicePath;
    delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;

    const state = initializeManagementAuthState({
      port: 10100,
      hostname: "0.0.0.0",
      defaultProvider: "test",
      providers: {},
    } as OcxConfig);

    expect(state.available).toBe(false);
    expect(readFileSync(servicePath, "utf8")).toBe(oversized);
    expect(existsSync(adminApiTokenFilePath(root))).toBe(false);
  });

  test("a missing explicitly configured service admin token does not generate a primary token", () => {
    const root = tempRoot();
    process.env.OPENCODEX_HOME = root;
    process.env.OCX_ADMIN_TOKEN_FILE = serviceAdminTokenFilePath(root);
    delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;

    const state = initializeManagementAuthState({
      port: 10100,
      hostname: "0.0.0.0",
      defaultProvider: "test",
      providers: {},
    } as OcxConfig);

    expect(state.available).toBe(false);
    expect(existsSync(adminApiTokenFilePath(root))).toBe(false);
    expect(existsSync(serviceAdminTokenFilePath(root))).toBe(false);
  });

  test("omits the service admin token file from all four definitions when it does not exist", () => {
    const root = tempRoot();
    process.env.OPENCODEX_HOME = root;
    delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;

    const definitions = [
      buildPlist(),
      buildUnit(),
      buildWindowsServiceScript({ bun: "C:\\ocx\\bun.exe", cli: "C:\\ocx\\cli.ts" }, 10100),
      buildWinswXml(
        { bun: "C:\\ocx\\bun.exe", cli: "C:\\ocx\\cli.ts" },
        { USERDOMAIN: "OCX", USERNAME: "tester", OPENCODEX_HOME: root },
        10100,
      ),
    ];

    for (const definition of definitions) {
      expect(definition).not.toContain("OCX_ADMIN_TOKEN_FILE");
    }
  });

  test("stores only the service token path in all four service definitions", () => {
    const root = tempRoot();
    const secret = "admin-value-must-not-be-serialized";
    process.env.OPENCODEX_HOME = root;
    process.env.OPENCODEX_ADMIN_AUTH_TOKEN = secret;
    const tokenPath = serviceAdminTokenFilePath(root);
    expect(writeServiceAdminTokenFile({
      configDir: root,
      env: process.env,
      platform: "linux",
    })).toBe(tokenPath);
    const definitions = [
      buildPlist(),
      buildUnit(),
      buildWindowsServiceScript({ bun: "C:\\ocx\\bun.exe", cli: "C:\\ocx\\cli.ts" }, 10100),
      buildWinswXml(
        { bun: "C:\\ocx\\bun.exe", cli: "C:\\ocx\\cli.ts" },
        { USERDOMAIN: "OCX", USERNAME: "tester", OPENCODEX_ADMIN_AUTH_TOKEN: secret },
        10100,
      ),
    ];

    const escapedTokenPath = tokenPath.replace(/\\/g, "\\\\");
    for (const definition of definitions) {
      expect(definition.includes(tokenPath) || definition.includes(escapedTokenPath)).toBe(true);
      expect(definition).toContain("OCX_ADMIN_TOKEN_FILE");
      expect(definition).not.toContain("OPENCODEX_ADMIN_AUTH_TOKEN");
      expect(definition).not.toContain(secret);
    }
  });

  test("persists the resolved OpenCodex home in all four service definitions", () => {
    const relativeHome = join("tests", ".tmp-relative-service-home");
    const absoluteHome = resolve(relativeHome);
    tempRoots.push(absoluteHome);
    process.env.OPENCODEX_HOME = relativeHome;

    const plist = buildPlist();
    const unit = buildUnit();
    const windows = buildWindowsServiceScript(
      { bun: "C:\\ocx\\bun.exe", cli: "C:\\ocx\\cli.ts" },
      10100,
    );
    const winsw = buildWinswXml(
      { bun: "C:\\ocx\\bun.exe", cli: "C:\\ocx\\cli.ts" },
      { USERDOMAIN: "OCX", USERNAME: "tester", OPENCODEX_HOME: relativeHome },
      10100,
    );

    expect(plist).toContain(`<key>OPENCODEX_HOME</key><string>${absoluteHome}</string>`);
    expect(unit).toContain(`Environment="OPENCODEX_HOME=${absoluteHome.replace(/\\/g, "\\\\")}"`);
    expect(windows).toContain(`set "OPENCODEX_HOME=${absoluteHome}"`);
    expect(winsw).toContain(`<env name="OPENCODEX_HOME" value="${absoluteHome}"/>`);
  });

  test("service uninstall cleanup removes both service-delivered token files", () => {
    const root = tempRoot();
    const dataPath = join(root, "service-api-token");
    const adminPath = serviceAdminTokenFilePath(root);
    const primaryPath = adminApiTokenFilePath(root);
    writeFileSync(dataPath, "data-admin\n", "utf8");
    writeFileSync(adminPath, "service-admin\n", "utf8");
    writeFileSync(primaryPath, `ocx_admin_${"c".repeat(43)}\n`, "utf8");

    expect(removeServiceTokenFiles(root)).toEqual([]);

    expect(existsSync(dataPath)).toBe(false);
    expect(existsSync(adminPath)).toBe(false);
    expect(existsSync(primaryPath)).toBe(true);
    expect(removeServiceTokenFiles(root)).toEqual([]);
  });

  test("service token cleanup reports a residual secret without exposing its path", () => {
    const root = tempRoot();
    const dataPath = join(root, "service-api-token");
    const adminPath = serviceAdminTokenFilePath(root);
    writeFileSync(dataPath, "data-admin\n", "utf8");
    writeFileSync(adminPath, "service-admin\n", "utf8");

    const residual = removeServiceTokenFiles(root, path => {
      if (path === adminPath) throw new Error("locked");
      unlinkSync(path);
    });

    expect(residual).toEqual(["service-admin-token"]);
    expect(residual.join(" ")).not.toContain(root);
    expect(existsSync(dataPath)).toBe(false);
    expect(existsSync(adminPath)).toBe(true);
  });
});
