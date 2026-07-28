package codex

// Detect, and optionally terminate, long-lived Codex app-server processes that
// keep an in-memory model catalog after `ocx sync` rewrites the on-disk files
// (#476). The Go form of src/codex/app-server-processes.ts.
//
// Matching is deliberately NARROW and that is the whole safety story here: this
// code decides what receives a signal. `app-server` must be the Codex
// SUBCOMMAND (not merely a later argument), or the executable must be
// codex-code-mode-host. A broad `*codex*` sweep would match unrelated tools
// such as `hermes-codex-bridge-mcp`, and killing one of those would be a
// user-visible data loss rather than a stale model list.

import (
	"os"
	"os/exec"
	"path"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// StaleAppServerHint is the dashboard/CLI hint shown after a catalog or
// models_cache write.
const StaleAppServerHint = "If Codex still shows an older model list, restart its long-lived app-server process after sync (ocx sync --restart-codex)."

// codexTargetTripleBody matches the Rust-style target triple on official
// platform-baked Codex binaries (x86_64-unknown-linux-musl,
// aarch64-apple-darwin, x86_64-pc-windows-msvc). It requires arch-vendor-os
// with an optional env segment rather than a broad `codex-*` wildcard, so a
// local script named `codex-helper` never looks like a release binary.
const codexTargetTripleBody = `[a-z0-9_]+-[a-z0-9_]+-[a-z0-9_]+(?:-[a-z0-9_]+)?`

// WindowsCodexBasenameCandidatePattern is the narrow Win32_Process CommandLine
// pre-filter. It allows an optional closing quote after the executable
// basename so a quoted path such as `"C:\Program Files\...\codex.exe"
// app-server` still reaches GetOwner.
const WindowsCodexBasenameCandidatePattern = `(^|[/\\\s'"=])codex(-` + codexTargetTripleBody + `)?([.]exe|[.]cmd)?['"]?(\s|$)`

// WindowsCodexCodeModeHostCandidatePattern is the second half of that
// pre-filter.
const WindowsCodexCodeModeHostCandidatePattern = `codex-code-mode-host`

var (
	windowsCodexBasenameCandidateRe = regexp.MustCompile(`(?i)` + WindowsCodexBasenameCandidatePattern)
	windowsCodexCodeModeHostRe      = regexp.MustCompile(`(?i)` + WindowsCodexCodeModeHostCandidatePattern)
	codexTargetTripleBasenameRe     = regexp.MustCompile(`^codex-` + codexTargetTripleBody + `(?:\.exe|\.cmd)?$`)
	unixProcStatusUIDRe             = regexp.MustCompile(`(?m)^Uid:\s+(\d+)`)
)

// IsWindowsCodexCandidateCommandLine reports whether a Windows CommandLine is
// worth paying a GetOwner call for. Ownership scoping happens afterwards.
func IsWindowsCodexCandidateCommandLine(commandLine string) bool {
	return windowsCodexBasenameCandidateRe.MatchString(commandLine) ||
		windowsCodexCodeModeHostRe.MatchString(commandLine)
}

// AppServerProcess is a matched Codex app-server.
type AppServerProcess struct {
	PID         int
	CommandLine string
}

// ProcessSnapshot is one row of a platform process listing, before matching.
type ProcessSnapshot struct {
	PID         int
	CommandLine string
	UID         *int
	Owner       string
}

// TokenizeCommandLine splits a process command line into argv-like tokens,
// understanding simple single and double quoting.
//
// Quoting matters for correctness, not tidiness: without it a Windows path
// like `"C:\Program Files\codex.exe" app-server` tokenizes into `C:\Program`
// and the subcommand check reads `Files\codex.exe` instead of `app-server`.
func TokenizeCommandLine(commandLine string) []string {
	tokens := []string{}
	current := strings.Builder{}
	var quote rune
	for _, ch := range commandLine {
		if quote != 0 {
			if ch == quote {
				quote = 0
			} else {
				current.WriteRune(ch)
			}
			continue
		}
		if ch == '"' || ch == '\'' {
			quote = ch
			continue
		}
		if unicode.IsSpace(ch) {
			if current.Len() > 0 {
				tokens = append(tokens, current.String())
				current.Reset()
			}
			continue
		}
		current.WriteRune(ch)
	}
	if current.Len() > 0 {
		tokens = append(tokens, current.String())
	}
	return tokens
}

func tokenBasename(token string) string {
	lowered := strings.ReplaceAll(strings.ToLower(token), `\`, "/")
	return path.Base(lowered)
}

func isCodexExecutableToken(token string) bool {
	base := tokenBasename(token)
	return base == "codex" || base == "codex.exe" || base == "codex.cmd" ||
		codexTargetTripleBasenameRe.MatchString(base)
}

func isCodeModeHostToken(token string) bool {
	base := tokenBasename(token)
	return base == "codex-code-mode-host" || base == "codex-code-mode-host.exe"
}

func isInterpreterToken(token string) bool {
	switch tokenBasename(token) {
	case "node", "node.exe", "bun", "bun.exe", "deno", "deno.exe":
		return true
	}
	return false
}

// appServerGlobalOptionsWithValue are the Codex global options that consume a
// FOLLOWING token when written without `=`. The list is explicit so an unknown
// flag stays boolean: over-consuming would swallow the real subcommand and
// silently stop matching a genuine app-server, while under-consuming would let
// an option VALUE be read as the subcommand.
var appServerGlobalOptionsWithValue = map[string]bool{
	"--enable": true, "--disable": true,
	"--config": true, "-c": true,
	"--profile": true, "-p": true,
	"--model": true, "-m": true,
	"--sandbox": true, "-s": true,
	"--ask-for-approval": true, "-a": true,
	"--local-provider": true,
	"--add-dir":         true,
	"--cd":              true, "-C": true,
	"--color": true,
	"--image": true, "-i": true,
	"--output-schema":       true,
	"--output-last-message": true, "-o": true,
}

type cliOptionToken struct {
	name           string
	hasInlineValue bool
}

// splitCliOptionToken parses an option token into its flag name and whether the
// value is inline (`--opt=value`).
func splitCliOptionToken(token string) (cliOptionToken, bool) {
	if !strings.HasPrefix(token, "-") || token == "-" || token == "--" {
		return cliOptionToken{}, false
	}
	if strings.HasPrefix(token, "--") {
		if eq := strings.Index(token, "="); eq >= 0 {
			return cliOptionToken{name: strings.ToLower(token[:eq]), hasInlineValue: true}, true
		}
		return cliOptionToken{name: strings.ToLower(token)}, true
	}
	// Short-option case is PRESERVED: `-c` is --config but `-C` is --cd, so
	// lowercasing here would consume the wrong number of tokens.
	if eq := strings.Index(token, "="); eq >= 0 {
		return cliOptionToken{name: token[:eq], hasInlineValue: true}, true
	}
	return cliOptionToken{name: token}, true
}

// advancePastCodexGlobalOption returns the index of the next token, consuming a
// value for the known value-taking global options.
func advancePastCodexGlobalOption(tokens []string, index int) int {
	option, isOption := splitCliOptionToken(tokens[index])
	if !isOption {
		return index + 1
	}
	next := index + 1
	if !option.hasInlineValue && appServerGlobalOptionsWithValue[option.name] &&
		next < len(tokens) && !strings.HasPrefix(tokens[next], "-") {
		next++
	}
	return next
}

// isCodeModeHostProcess reports whether code-mode-host is the executable or the
// interpreter entrypoint, rather than a later argument.
func isCodeModeHostProcess(tokens []string) bool {
	if len(tokens) == 0 {
		return false
	}
	if isCodeModeHostToken(tokens[0]) {
		return true
	}
	return isInterpreterToken(tokens[0]) && len(tokens) > 1 && isCodeModeHostToken(tokens[1])
}

// AppServerProcessIdentity is a stable identity for PID-reuse checks: the pid
// plus its whitespace-normalized command line.
func AppServerProcessIdentity(process AppServerProcess) string {
	normalized := strings.Join(strings.Fields(process.CommandLine), " ")
	return strconv.Itoa(process.PID) + "\x00" + normalized
}

// IsCodexAppServerCommandLine reports whether a command line is a Codex
// app-server (or code-mode host) worth restarting.
func IsCodexAppServerCommandLine(commandLine string) bool {
	tokens := TokenizeCommandLine(strings.TrimSpace(commandLine))
	if len(tokens) == 0 {
		return false
	}
	if isCodeModeHostProcess(tokens) {
		return true
	}
	// Codex must be argv0. Requiring this is what keeps
	// `node worker.js codex app-server` unmatched.
	if !isCodexExecutableToken(tokens[0]) {
		return false
	}
	for index := 1; index < len(tokens); {
		token := tokens[index]
		if strings.HasPrefix(token, "-") {
			index = advancePastCodexGlobalOption(tokens, index)
			continue
		}
		// The first non-option after the globals is the Codex subcommand.
		return strings.ToLower(token) == "app-server"
	}
	return false
}

func parseUnixProcStatusUID(status string) *int {
	match := unixProcStatusUIDRe.FindStringSubmatch(status)
	if match == nil {
		return nil
	}
	uid, err := strconv.Atoi(match[1])
	if err != nil {
		return nil
	}
	return &uid
}

// listUnixProcSnapshots reads /proc, keeping only the caller's own processes
// when a uid is known.
func listUnixProcSnapshots(uid *int) []ProcessSnapshot {
	out := []ProcessSnapshot{}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return out
	}
	for _, entry := range entries {
		pid, convErr := strconv.Atoi(entry.Name())
		// pid <= 1 is excluded so init can never be a candidate.
		if convErr != nil || pid <= 1 {
			continue
		}
		status, statusErr := os.ReadFile("/proc/" + entry.Name() + "/status")
		if statusErr != nil {
			continue // exited mid-scan
		}
		processUID := parseUnixProcStatusUID(string(status))
		if uid != nil && processUID != nil && *processUID != *uid {
			continue
		}
		raw, cmdErr := os.ReadFile("/proc/" + entry.Name() + "/cmdline")
		if cmdErr != nil {
			continue
		}
		commandLine := strings.TrimSpace(strings.ReplaceAll(string(raw), "\x00", " "))
		if commandLine == "" {
			continue
		}
		out = append(out, ProcessSnapshot{PID: pid, CommandLine: commandLine, UID: processUID})
	}
	return out
}

// listDarwinSnapshots shells out to ps, scoped to the caller's uid when known.
func listDarwinSnapshots(uid *int) []ProcessSnapshot {
	out := []ProcessSnapshot{}
	var command *exec.Cmd
	if uid != nil {
		command = exec.Command("ps", "-u", strconv.Itoa(*uid), "-o", "pid=,command=")
	} else {
		command = exec.Command("ps", "-axo", "pid=,uid=,command=")
	}
	output, err := command.Output()
	if err != nil {
		return out
	}
	for _, raw := range strings.Split(string(output), "\n") {
		line := strings.TrimSpace(strings.TrimSuffix(raw, "\r"))
		if line == "" {
			continue
		}
		if uid != nil {
			pid, commandLine, ok := splitLeadingInt(line)
			if !ok || pid <= 1 || commandLine == "" {
				continue
			}
			scoped := *uid
			out = append(out, ProcessSnapshot{PID: pid, CommandLine: commandLine, UID: &scoped})
			continue
		}
		pid, rest, ok := splitLeadingInt(line)
		if !ok || pid <= 1 {
			continue
		}
		processUID, commandLine, uidOk := splitLeadingInt(rest)
		if !uidOk || commandLine == "" {
			continue
		}
		owned := processUID
		out = append(out, ProcessSnapshot{PID: pid, CommandLine: commandLine, UID: &owned})
	}
	return out
}

// splitLeadingInt peels a leading integer field off a whitespace-separated
// line and returns the remainder.
func splitLeadingInt(line string) (int, string, bool) {
	trimmed := strings.TrimLeft(line, " \t")
	end := 0
	for end < len(trimmed) && trimmed[end] >= '0' && trimmed[end] <= '9' {
		end++
	}
	if end == 0 {
		return 0, "", false
	}
	value, err := strconv.Atoi(trimmed[:end])
	if err != nil {
		return 0, "", false
	}
	rest := strings.TrimSpace(trimmed[end:])
	return value, rest, true
}
