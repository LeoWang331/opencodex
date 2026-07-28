package codex

// Enumeration and the signal path for Codex app-server processes. Split from
// the matching rules in app_server_processes.go because THIS file is the part
// that can affect other processes.

import (
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// AppServerProcessIO holds the injection seams, so the whole flow is testable
// without signalling anything real.
type AppServerProcessIO struct {
	Platform      string
	GetUID        func() *int
	ListSnapshots func() []ProcessSnapshot
	IsAlive       func(pid int) bool
	Kill          func(pid int, signal os.Signal) error
	WaitExit      func(pid int, timeout time.Duration) bool
	Now           func() time.Time
}

// powerShellSingleQuotedIgnoreCaseMatch embeds a regex source in a PowerShell
// single-quoted -match operand, where '' escapes a quote.
func powerShellSingleQuotedIgnoreCaseMatch(pattern string) string {
	return "'(?i)" + strings.ReplaceAll(pattern, "'", "''") + "'"
}

// ListWindowsSnapshots enumerates Codex-shaped processes owned by the invoking
// user.
//
// PowerShell is the SOLE path on Windows. WMIC lacks reliable owner data and is
// absent from many Windows 11 installs, and returning unscoped rows would
// contradict the current-user restart contract: we would be listing processes
// belonging to other users as restart candidates.
//
// CIM instance methods need Invoke-CimMethod; a direct .GetOwner() call fails.
// Candidates are pre-filtered by command line so GetOwner is not paid once per
// process on the machine.
func ListWindowsSnapshots() []ProcessSnapshot {
	out := []ProcessSnapshot{}
	basenameMatch := powerShellSingleQuotedIgnoreCaseMatch(WindowsCodexBasenameCandidatePattern)
	codeModeMatch := powerShellSingleQuotedIgnoreCaseMatch(WindowsCodexCodeModeHostCandidatePattern)
	// Newlines keep -Command a real script: space-joined statements would need
	// explicit semicolons.
	script := strings.Join([]string{
		"$ErrorActionPreference='SilentlyContinue'",
		"$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
		"Get-CimInstance Win32_Process | Where-Object {",
		"  -not [string]::IsNullOrWhiteSpace($_.CommandLine) -and (",
		"    $_.CommandLine -match " + basenameMatch + " -or",
		"    $_.CommandLine -match " + codeModeMatch,
		"  )",
		"} | ForEach-Object {",
		"  try {",
		"    $o=Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction Stop",
		"    if($null -eq $o -or $o.ReturnValue -ne 0 -or [string]::IsNullOrWhiteSpace($o.User)){return}",
		"    $owner=if($o.Domain){\"$($o.Domain)\\$($o.User)\"}else{$o.User}",
		"    if($owner -ine $me){return}",
		"    $cmd=($_.CommandLine -replace \"`t\",\" \")",
		"    \"{0}`t{1}`t{2}\" -f $_.ProcessId, $cmd, $owner",
		"  } catch { }",
		"}",
	}, "\n")
	command := exec.Command("powershell.exe",
		"-NoProfile", "-NoLogo", "-NonInteractive", "-WindowStyle", "Hidden",
		"-Command", script)
	output, err := command.Output()
	if err != nil {
		return out
	}
	for _, raw := range strings.Split(string(output), "\n") {
		line := strings.TrimSuffix(raw, "\r")
		tab := strings.Index(line, "\t")
		if tab <= 0 {
			continue
		}
		secondTab := strings.Index(line[tab+1:], "\t")
		if secondTab < 0 {
			continue
		}
		secondTab += tab + 1
		pid, convErr := strconv.Atoi(strings.TrimSpace(line[:tab]))
		commandLine := strings.TrimSpace(line[tab+1 : secondTab])
		owner := strings.TrimSpace(line[secondTab+1:])
		if convErr != nil || pid <= 1 || commandLine == "" || owner == "" {
			continue
		}
		out = append(out, ProcessSnapshot{PID: pid, CommandLine: commandLine, Owner: owner})
	}
	return out
}

func currentUID() *int {
	if runtime.GOOS == "windows" {
		return nil
	}
	uid := os.Getuid()
	if uid < 0 {
		return nil
	}
	return &uid
}

func defaultListSnapshots(platform string, getUID func() *int) []ProcessSnapshot {
	switch platform {
	case "windows":
		return ListWindowsSnapshots()
	case "darwin":
		return listDarwinSnapshots(getUID())
	default:
		return listUnixProcSnapshots(getUID())
	}
}

func (io AppServerProcessIO) resolved() AppServerProcessIO {
	resolved := io
	if resolved.Platform == "" {
		resolved.Platform = runtime.GOOS
	}
	if resolved.GetUID == nil {
		resolved.GetUID = currentUID
	}
	if resolved.Now == nil {
		resolved.Now = time.Now
	}
	return resolved
}

// ListCodexAppServerProcesses returns the matched, de-duplicated processes.
func ListCodexAppServerProcesses(io AppServerProcessIO) []AppServerProcess {
	resolved := io.resolved()
	var snapshots []ProcessSnapshot
	if resolved.ListSnapshots != nil {
		snapshots = resolved.ListSnapshots()
	} else {
		snapshots = defaultListSnapshots(resolved.Platform, resolved.GetUID)
	}
	seen := map[int]bool{}
	matched := []AppServerProcess{}
	for _, snapshot := range snapshots {
		if seen[snapshot.PID] || !IsCodexAppServerCommandLine(snapshot.CommandLine) {
			continue
		}
		seen[snapshot.PID] = true
		matched = append(matched, AppServerProcess{PID: snapshot.PID, CommandLine: snapshot.CommandLine})
	}
	return matched
}

// FormatStaleAppServerWarning renders the warning shown when a catalog write
// happened while app-servers are still holding the old list.
func FormatStaleAppServerWarning(processes []AppServerProcess) string {
	pids := make([]string, 0, len(processes))
	for _, process := range processes {
		pids = append(pids, strconv.Itoa(process.PID))
	}
	plural := "s"
	if len(processes) == 1 {
		plural = ""
	}
	return "WARNING: " + strconv.Itoa(len(processes)) + " Codex app-server process(es) still running (PID" +
		plural + ": " + strings.Join(pids, ", ") + "). " +
		"Disk catalog/cache were updated, but Codex may keep showing the old model list until those processes restart. " +
		"Re-run with `ocx sync --restart-codex` (or `ocx sync-cache --restart-codex`) to send SIGTERM only to matching app-server processes. " +
		"Active turns may be interrupted."
}

// RestartFailure records one process that could not be signalled.
type RestartFailure struct {
	PID   int
	Error string
}

// RestartResult reports what the signal pass did.
type RestartResult struct {
	Requested []int
	Stopped   []int
	Surviving []int
	Failed    []RestartFailure
}

// RestartCodexAppServers sends SIGTERM to the matched processes and waits
// briefly. It NEVER escalates to SIGKILL: an app-server may be mid-turn, and
// the worst acceptable outcome is a surviving process we report, not a killed
// one that loses work.
func RestartCodexAppServers(processes []AppServerProcess, io AppServerProcessIO) RestartResult {
	resolved := io.resolved()
	isAlive := resolved.IsAlive
	if isAlive == nil {
		isAlive = processAlive
	}
	kill := resolved.Kill
	if kill == nil {
		kill = signalProcess
	}
	waitExit := resolved.WaitExit
	if waitExit == nil {
		waitExit = waitForProcessExit
	}

	result := RestartResult{Requested: make([]int, 0, len(processes))}
	for _, process := range processes {
		result.Requested = append(result.Requested, process.PID)
	}

	// Re-resolve the live set immediately before signalling so a RECYCLED PID is
	// never killed. Requiring the same pid+command-line identity means a brand
	// new Codex-shaped process that happened to inherit the PID does not get
	// SIGTERM meant for its predecessor.
	liveByPID := map[int]AppServerProcess{}
	for _, live := range ListCodexAppServerProcesses(resolved) {
		liveByPID[live.PID] = live
	}

	signaled := []AppServerProcess{}
	for _, process := range processes {
		live, present := liveByPID[process.PID]
		if !present || AppServerProcessIdentity(live) != AppServerProcessIdentity(process) {
			// The original target exited, or the identity changed. Do not
			// signal whatever holds the PID now.
			if !isAlive(process.PID) {
				result.Stopped = append(result.Stopped, process.PID)
			}
			continue
		}
		if err := kill(process.PID, syscall.SIGTERM); err != nil {
			if isAlive(process.PID) {
				result.Failed = append(result.Failed, RestartFailure{PID: process.PID, Error: err.Error()})
				result.Surviving = append(result.Surviving, process.PID)
			} else {
				result.Stopped = append(result.Stopped, process.PID)
			}
			continue
		}
		signaled = append(signaled, process)
	}

	// One SHARED deadline, so N survivors cost ~2s in total rather than N times
	// 2s.
	deadline := resolved.Now().Add(2 * time.Second)
	for _, process := range signaled {
		remaining := deadline.Sub(resolved.Now())
		if remaining < 0 {
			remaining = 0
		}
		if waitExit(process.PID, remaining) || !isAlive(process.PID) {
			result.Stopped = append(result.Stopped, process.PID)
		} else {
			result.Surviving = append(result.Surviving, process.PID)
		}
	}
	return result
}

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return process.Signal(syscall.Signal(0)) == nil
}

func signalProcess(pid int, signal os.Signal) error {
	process, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return process.Signal(signal)
}

func waitForProcessExit(pid int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if !processAlive(pid) {
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return !processAlive(pid)
}

// AppServerLog is the console seam used after a catalog write.
type AppServerLog interface {
	Log(message string)
	Error(message string)
}

// AfterCatalogWriteOptions configures the post-write handling.
type AfterCatalogWriteOptions struct {
	Restart bool
	Log     AppServerLog
	IO      AppServerProcessIO
}

// AfterCatalogWriteResult reports what happened.
type AfterCatalogWriteResult struct {
	Processes []AppServerProcess
	Warned    bool
	Restart   *RestartResult
	Hint      string
}

// AfterCatalogWriteHandleAppServers warns about stale app-servers after a
// catalog or cache write, or restarts them when the caller asked for it.
func AfterCatalogWriteHandleAppServers(options AfterCatalogWriteOptions) AfterCatalogWriteResult {
	processes := ListCodexAppServerProcesses(options.IO)
	result := AfterCatalogWriteResult{Processes: processes, Hint: StaleAppServerHint}
	if len(processes) == 0 {
		return result
	}
	pids := make([]string, 0, len(processes))
	for _, process := range processes {
		pids = append(pids, strconv.Itoa(process.PID))
	}
	if !options.Restart {
		if options.Log != nil {
			options.Log.Error(FormatStaleAppServerWarning(processes))
		}
		result.Warned = true
		return result
	}
	if options.Log != nil {
		options.Log.Log("Stopping Codex app-server process(es): " + strings.Join(pids, ", ") +
			" (active turns may be interrupted).")
	}
	restart := RestartCodexAppServers(processes, options.IO)
	result.Restart = &restart
	if options.Log != nil {
		if len(restart.Stopped) > 0 {
			options.Log.Log("Stopped Codex app-server PID(s): " + joinInts(restart.Stopped))
		}
		for _, failure := range restart.Failed {
			options.Log.Error("Failed to stop Codex app-server PID " + strconv.Itoa(failure.PID) + ": " + failure.Error)
		}
		if len(restart.Surviving) > 0 {
			options.Log.Error("Codex app-server PID(s) still running after SIGTERM: " + joinInts(restart.Surviving) +
				". Stop them manually if the model list stays stale.")
		}
	}
	return result
}

func joinInts(values []int) string {
	text := make([]string, 0, len(values))
	for _, value := range values {
		text = append(text, strconv.Itoa(value))
	}
	return strings.Join(text, ", ")
}
