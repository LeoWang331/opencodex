package codex

import (
	"os"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The matcher decides what receives a signal, so the cases that MUST NOT match
// matter more than the ones that must. Each negative here is a process a broad
// `*codex*` sweep would have killed.
func TestIsCodexAppServerCommandLine(t *testing.T) {
	for _, testCase := range []struct {
		name        string
		commandLine string
		want        bool
	}{
		{"plain app-server", "codex app-server", true},
		{"absolute path", "/usr/local/bin/codex app-server", true},
		{"windows quoted path", `"C:\Program Files\Codex\codex.exe" app-server`, true},
		{"target triple binary", "/opt/codex-aarch64-apple-darwin app-server", true},
		{"global option before subcommand", "codex -c features.x=true app-server", true},
		{"inline value option", "codex --config=a=b app-server", true},
		{"code mode host", "/opt/codex-code-mode-host", true},
		{"interpreter code mode host", "node /opt/codex-code-mode-host", true},
		{"uppercase subcommand", "codex APP-SERVER", true},

		// A neighbouring tool whose NAME merely contains codex.
		{"unrelated bridge", "hermes-codex-bridge-mcp --serve", false},
		// app-server appears, but only as a later argument.
		{"app-server as argument", "node worker.js codex app-server", false},
		// A different Codex subcommand must never be signalled.
		{"other subcommand", "codex exec --model gpt-5", false},
		{"bare codex", "codex", false},
		{"empty", "", false},
		{"whitespace", "   ", false},
		// `--model app-server` is an option VALUE, not the subcommand.
		{"option value looks like subcommand", "codex --model app-server", false},
		// A repo path containing "opencodex" is not a Codex binary.
		{"repo path substring", "/home/u/opencodex/node_modules/.bin/tsx watch", false},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if got := IsCodexAppServerCommandLine(testCase.commandLine); got != testCase.want {
				t.Fatalf("IsCodexAppServerCommandLine(%q) = %v, want %v", testCase.commandLine, got, testCase.want)
			}
		})
	}
}

// Quoting is not cosmetic: without it a quoted Windows path shifts every token
// and the subcommand check reads the wrong one.
func TestTokenizeCommandLine(t *testing.T) {
	got := TokenizeCommandLine(`"C:\Program Files\codex.exe" app-server --cd 'my dir'`)
	want := []string{`C:\Program Files\codex.exe`, "app-server", "--cd", "my dir"}
	if strings.Join(got, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("tokens = %#v, want %#v", got, want)
	}
}

// A recycled PID must never inherit a SIGTERM aimed at its predecessor.
func TestRestartSkipsRecycledPid(t *testing.T) {
	target := AppServerProcess{PID: 4242, CommandLine: "codex app-server"}
	killed := []int{}
	result := RestartCodexAppServers([]AppServerProcess{target}, AppServerProcessIO{
		Platform: "linux",
		// The PID is alive, but it is now a DIFFERENT Codex-shaped process.
		ListSnapshots: func() []ProcessSnapshot {
			return []ProcessSnapshot{{PID: 4242, CommandLine: "codex --profile other app-server"}}
		},
		IsAlive:  func(int) bool { return true },
		Kill:     func(pid int, _ os.Signal) error { killed = append(killed, pid); return nil },
		WaitExit: func(int, time.Duration) bool { return true },
		Now:      time.Now,
	})
	if len(killed) != 0 {
		t.Fatalf("signalled a recycled pid: %v", killed)
	}
	if len(result.Stopped) != 0 || len(result.Surviving) != 0 {
		t.Fatalf("unexpected result for a recycled pid: %#v", result)
	}
}

// The identical process IS signalled, and only with SIGTERM.
func TestRestartSignalsMatchingIdentityWithSigtermOnly(t *testing.T) {
	target := AppServerProcess{PID: 77, CommandLine: "codex app-server"}
	signals := []os.Signal{}
	result := RestartCodexAppServers([]AppServerProcess{target}, AppServerProcessIO{
		Platform: "linux",
		ListSnapshots: func() []ProcessSnapshot {
			// Whitespace differs; identity normalizes it, so this still matches.
			return []ProcessSnapshot{{PID: 77, CommandLine: "codex  app-server"}}
		},
		IsAlive:  func(int) bool { return false },
		Kill:     func(_ int, signal os.Signal) error { signals = append(signals, signal); return nil },
		WaitExit: func(int, time.Duration) bool { return true },
		Now:      time.Now,
	})
	if len(signals) != 1 || signals[0] != syscall.SIGTERM {
		t.Fatalf("signals = %#v, want exactly one SIGTERM", signals)
	}
	for _, signal := range signals {
		if signal == syscall.SIGKILL {
			t.Fatal("SIGKILL must never be sent: an app-server may be mid-turn")
		}
	}
	if len(result.Stopped) != 1 || result.Stopped[0] != 77 {
		t.Fatalf("stopped = %#v, want [77]", result.Stopped)
	}
}

// Survivors share ONE deadline, so N of them cost ~2s total rather than N*2s.
func TestRestartSurvivorsShareOneDeadline(t *testing.T) {
	processes := []AppServerProcess{
		{PID: 1001, CommandLine: "codex app-server"},
		{PID: 1002, CommandLine: "codex app-server"},
		{PID: 1003, CommandLine: "codex app-server"},
	}
	clock := time.Now()
	waited := []time.Duration{}
	result := RestartCodexAppServers(processes, AppServerProcessIO{
		Platform: "linux",
		ListSnapshots: func() []ProcessSnapshot {
			out := []ProcessSnapshot{}
			for _, process := range processes {
				out = append(out, ProcessSnapshot{PID: process.PID, CommandLine: process.CommandLine})
			}
			return out
		},
		IsAlive: func(int) bool { return true },
		Kill:    func(int, os.Signal) error { return nil },
		WaitExit: func(_ int, timeout time.Duration) bool {
			waited = append(waited, timeout)
			// Burn the whole remaining budget, as a real survivor would.
			clock = clock.Add(timeout)
			return false
		},
		Now: func() time.Time { return clock },
	})
	if len(waited) != 3 {
		t.Fatalf("waited = %#v, want three waits", waited)
	}
	var total time.Duration
	for _, wait := range waited {
		total += wait
	}
	if total > 2*time.Second {
		t.Fatalf("total wait %v exceeds the shared 2s deadline", total)
	}
	if waited[1] >= waited[0] || waited[2] != 0 {
		t.Fatalf("waits did not draw down a shared deadline: %#v", waited)
	}
	if len(result.Surviving) != 3 {
		t.Fatalf("surviving = %#v, want all three", result.Surviving)
	}
}

// Warn without --restart; never signal anything in that path.
func TestAfterCatalogWriteWarnsWithoutRestart(t *testing.T) {
	log := &recordingLog{}
	killed := 0
	result := AfterCatalogWriteHandleAppServers(AfterCatalogWriteOptions{
		Restart: false,
		Log:     log,
		IO: AppServerProcessIO{
			Platform:      "linux",
			ListSnapshots: func() []ProcessSnapshot { return []ProcessSnapshot{{PID: 9, CommandLine: "codex app-server"}} },
			Kill:          func(int, os.Signal) error { killed++; return nil },
		},
	})
	if killed != 0 {
		t.Fatal("a warning-only pass must not signal anything")
	}
	if !result.Warned || result.Restart != nil {
		t.Fatalf("result = %#v, want warned with no restart", result)
	}
	if len(log.errors) != 1 || !strings.Contains(log.errors[0], "PID: 9") {
		t.Fatalf("errors = %#v, want a singular-PID warning", log.errors)
	}
	if strings.Contains(log.errors[0], "PIDs:") {
		t.Fatalf("single process must use the singular form: %q", log.errors[0])
	}
}

func TestAfterCatalogWriteNoProcessesStaysQuiet(t *testing.T) {
	log := &recordingLog{}
	result := AfterCatalogWriteHandleAppServers(AfterCatalogWriteOptions{
		Restart: true,
		Log:     log,
		IO: AppServerProcessIO{
			Platform:      "linux",
			ListSnapshots: func() []ProcessSnapshot { return nil },
		},
	})
	if result.Warned || len(log.logs) != 0 || len(log.errors) != 0 {
		t.Fatalf("a no-op sync must stay quiet: %#v %#v", log.logs, log.errors)
	}
	if result.Hint != StaleAppServerHint {
		t.Fatalf("hint = %q", result.Hint)
	}
}

// pid <= 1 is never a candidate, so init cannot be signalled.
func TestSplitLeadingIntRejectsNonNumeric(t *testing.T) {
	if _, _, ok := splitLeadingInt("notapid  codex app-server"); ok {
		t.Fatal("a non-numeric leading field must not parse as a pid")
	}
	pid, rest, ok := splitLeadingInt("  501   codex app-server")
	if !ok || pid != 501 || rest != "codex app-server" {
		t.Fatalf("pid=%d rest=%q ok=%v", pid, rest, ok)
	}
}

// The Windows pre-filter must admit real Codex command lines and reject a path
// that merely contains the substring.
func TestIsWindowsCodexCandidateCommandLine(t *testing.T) {
	for _, testCase := range []struct {
		commandLine string
		want        bool
	}{
		{`"C:\Program Files\Codex\codex.exe" app-server`, true},
		{`codex.cmd app-server`, true},
		{`C:\tools\codex-x86_64-pc-windows-msvc.exe app-server`, true},
		{`C:\n\codex-code-mode-host.exe`, true},
		{`C:\src\opencodex\node_modules\.bin\tsx.cmd watch`, false},
	} {
		if got := IsWindowsCodexCandidateCommandLine(testCase.commandLine); got != testCase.want {
			t.Fatalf("IsWindowsCodexCandidateCommandLine(%q) = %v, want %v", testCase.commandLine, got, testCase.want)
		}
	}
}

func TestAppServerProcessIdentityNormalizesWhitespace(t *testing.T) {
	a := AppServerProcessIdentity(AppServerProcess{PID: 5, CommandLine: "codex   app-server "})
	b := AppServerProcessIdentity(AppServerProcess{PID: 5, CommandLine: " codex app-server"})
	if a != b {
		t.Fatalf("identity differs across whitespace: %q vs %q", a, b)
	}
	if !strings.HasPrefix(a, strconv.Itoa(5)+"\x00") {
		t.Fatalf("identity = %q, want a pid-prefixed key", a)
	}
}

type recordingLog struct {
	logs   []string
	errors []string
}

func (r *recordingLog) Log(message string)   { r.logs = append(r.logs, message) }
func (r *recordingLog) Error(message string) { r.errors = append(r.errors, message) }
