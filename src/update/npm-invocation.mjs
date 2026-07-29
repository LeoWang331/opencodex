import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";

const CMD_META = /([()%!^"`<>&|;, *?])/g;
const NPM_CHILD_STRIPPED_ENV_KEYS = new Set([
  "OPENCODEX_ADMIN_AUTH_TOKEN",
  "OCX_ADMIN_TOKEN_FILE",
  "OPENCODEX_API_AUTH_TOKEN",
  "OCX_API_TOKEN_FILE",
]);

function escapeCmdArg(arg) {
  let out = String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  return `"${out}"`.replace(CMD_META, "^$1");
}

function escapeCmdCommand(command) {
  return command.replace(CMD_META, "^$1");
}

/**
 * Whether a PATH entry *is* the current directory. The hijack this guards against is
 * cmd.exe resolving a bare `npm` out of the directory opencodex was launched from, so
 * only that exact directory has to be skipped — every candidate we hand to spawn is an
 * absolute path, which is what actually defeats the implicit cwd-first search.
 *
 * Deliberately not a subtree test: npm's default Windows global prefix is
 * `%AppData%\npm` (`C:\Users\x\AppData\Roaming\npm`), so excluding everything under the
 * cwd would fail closed for anyone whose shell sits in their home directory — a normal
 * setup, not the untrusted-project case this hardening is for.
 */
function isCurrentDirectory(cwd, entry) {
  const left = win32.resolve(entry);
  const right = win32.resolve(cwd);
  return left.toLowerCase() === right.toLowerCase();
}

function cleanPathEntry(entry) {
  const trimmed = entry.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
  return trimmed;
}

function safePosixPathEntries(env, cwd) {
  const resolvedCwd = posix.resolve(cwd);
  return (env.PATH ?? "")
    .split(posix.delimiter)
    .filter(entry => entry && posix.isAbsolute(entry) && posix.resolve(entry) !== resolvedCwd);
}

function safeWindowsPathEntries(env, cwd) {
  return (env.PATH ?? env.Path ?? "")
    .split(win32.delimiter)
    .map(cleanPathEntry)
    .filter(entry => entry && win32.isAbsolute(entry) && !isCurrentDirectory(cwd, entry));
}

function sanitizedNpmChildEnv(platform, env, cwd) {
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) {
    const admissionKey = platform === "win32" ? key.toUpperCase() : key;
    if (NPM_CHILD_STRIPPED_ENV_KEYS.has(admissionKey)) delete childEnv[key];
    if (key.toLowerCase() === "path") delete childEnv[key];
    if (platform === "win32" && key.toLowerCase() === "nodefaultcurrentdirectoryinexepath") {
      delete childEnv[key];
    }
  }
  childEnv.PATH = (platform === "win32"
    ? safeWindowsPathEntries(env, cwd)
    : safePosixPathEntries(env, cwd)).join(platform === "win32" ? win32.delimiter : posix.delimiter);
  if (platform === "win32") {
    // npm.cmd shims can fall back to a bare `node` command. Prevent cmd.exe from
    // searching the launch directory before the sanitized absolute PATH entries.
    childEnv.NoDefaultCurrentDirectoryInExePath = "1";
  }
  return childEnv;
}

function resolvePosixNpmCommand(env, deps) {
  const exists = deps.exists ?? existsSync;
  const cwd = deps.cwd ?? process.cwd();
  const pathEntries = safePosixPathEntries(env, cwd);

  for (const entry of pathEntries) {
    const candidate = posix.join(entry, "npm");
    if (exists(candidate)) return posix.resolve(candidate);
  }
  return null;
}

export function resolveNpmCommand(
  platform = process.platform,
  env = process.env,
  deps = {},
) {
  if (platform !== "win32") return resolvePosixNpmCommand(env, deps);
  const exists = deps.exists ?? existsSync;
  const cwd = deps.cwd ?? process.cwd();
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  const pathEntries = safeWindowsPathEntries(env, cwd);

  for (const entry of pathEntries) {
    for (const extension of extensions) {
      const candidate = win32.join(entry, `npm${extension.toLowerCase()}`);
      if (exists(candidate)) return win32.resolve(candidate);
    }
  }
  return null;
}

function systemCommandProcessor(env) {
  const systemRoot = env.SystemRoot ?? env.windir;
  if (systemRoot && win32.isAbsolute(systemRoot)) {
    return win32.join(systemRoot, "System32", "cmd.exe");
  }
  const comSpec = env.ComSpec;
  return comSpec && win32.isAbsolute(comSpec) ? win32.resolve(comSpec) : null;
}

export function npmInvocation(
  args,
  platform = process.platform,
  env = process.env,
  deps = {},
) {
  const npm = resolveNpmCommand(platform, env, deps);
  if (!npm) return null;
  const childEnv = sanitizedNpmChildEnv(platform, env, deps.cwd ?? process.cwd());
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(npm)) {
    return { file: npm, args: [...args], options: { env: childEnv } };
  }

  const commandProcessor = systemCommandProcessor(env);
  if (!commandProcessor) return null;
  const line = [escapeCmdCommand(npm), ...args.map(escapeCmdArg)].join(" ");
  return {
    file: commandProcessor,
    args: ["/d", "/s", "/c", `"${line}"`],
    options: { windowsVerbatimArguments: true, env: childEnv },
  };
}
