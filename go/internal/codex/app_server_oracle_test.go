package codex

import "testing"

// A DIFFERENTIAL table captured by RUNNING the TypeScript oracle
// (src/codex/app-server-processes.ts isCodexAppServerCommandLine) over this
// exact corpus, not by reading it. Regenerate with:
//
//	bun -e 'const m = await import("./src/codex/app-server-processes.ts"); ...'
//
// The awkward-looking entries are the point. `codex --add-dir /a /b app-server`
// is FALSE because --add-dir consumes `/a`, leaving `/b` as the first
// non-option token, so the subcommand reads `/b`. `codex --unknown-flag
// app-server` is TRUE because an unknown flag stays boolean and consumes
// nothing. Those two encode the narrow-matching contract in opposite
// directions, and a naive port gets both wrong.
func TestMatchesTypeScriptOracleCorpus(t *testing.T) {
	for _, testCase := range []struct {
		commandLine string
		oracle      bool
	}{
		{"codex app-server", true},
		{"/usr/local/bin/codex app-server", true},
		{`"C:\Program Files\Codex\codex.exe" app-server`, true},
		{"/opt/codex-aarch64-apple-darwin app-server", true},
		{"codex -c features.x=true app-server", true},
		{"codex --config=a=b app-server", true},
		{"/opt/codex-code-mode-host", true},
		{"node /opt/codex-code-mode-host", true},
		{"codex APP-SERVER", true},
		{"hermes-codex-bridge-mcp --serve", false},
		{"node worker.js codex app-server", false},
		{"codex exec --model gpt-5", false},
		{"codex", false},
		{"", false},
		{"   ", false},
		{"codex --model app-server", false},
		{"/home/u/opencodex/node_modules/.bin/tsx watch", false},
		{"codex -C /tmp app-server", true},
		{"codex --profile p app-server", true},
		{"codex --unknown-flag app-server", true},
		{"codex --add-dir /a /b app-server", false},
		{"bun /opt/codex-code-mode-host --x", true},
		{"codex.cmd app-server", true},
		{"codex-x86_64-pc-windows-msvc.exe app-server", true},

		// These four isolate the argv0 gate, and nothing else does. Every other
		// negative above is ALSO rejected by the subcommand check, so deleting
		// `if !isCodexExecutableToken(tokens[0])` left the rest of this table
		// green -- a mutation run proved it. Here the subcommand genuinely IS
		// `app-server`, so only "Codex must be argv0" can reject them. These are
		// the processes a broad sweep would actually SIGTERM.
		{"hermes-codex-bridge-mcp app-server", false},
		{"/usr/bin/some-tool app-server", false},
		{"python3 app-server", false},
		{"not-codex app-server --port 1", false},
	} {
		if got := IsCodexAppServerCommandLine(testCase.commandLine); got != testCase.oracle {
			t.Errorf("IsCodexAppServerCommandLine(%q) = %v, oracle says %v", testCase.commandLine, got, testCase.oracle)
		}
	}
}
