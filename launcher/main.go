// DF Trainer launcher: installer, launcher and updater in one small exe. Licence: AGPL-3.0-only.
//
// First run (from anywhere but its install folder): copies itself to %LOCALAPPDATA%\DFTrainer, unpacks the app it
// carries, adds Start Menu and Desktop shortcuts and an "Apps & features" entry, then starts the installed copy.
//
// Every start after that:
//  1. if the panel already runs, just opens its window again (one panel at a time)
//  2. checks the update channel (GitHub Releases) for a newer signed version and installs it (a few seconds at most;
//     offline or slow, it starts what it has and the panel finishes the update in the background)
//  3. starts the panel (server.js) with the Node.js Dauntless Forever installed, hidden, and shows it in its own
//     window (WebView2, the web engine built into Windows); closing the window closes DF Trainer
//  4. if a freshly updated version does not come up, it goes back to the previous one and never retries that version
//
// Other modes: --stage (used by the panel: fetch and install an update, answer JSON), --check (JSON only),
// --after <pid> (wait for the old panel to exit, then start; the panel's Restart button), --uninstall.
package main

import (
	"archive/zip"
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var (
	launcherVersion = "1.0.0" // set at build: -X main.launcherVersion=...
	pubKeyB64       = ""      // the release signing key's public half: -X main.pubKeyB64=...
	defaultRepo     = ""      // owner/repo of the update channel: -X main.defaultRepo=...
)

//go:embed embedded/app.zip
var embeddedApp []byte

//go:embed embedded/app-version.txt
var embeddedVersionRaw string

func embeddedVersion() string { return strings.TrimSpace(embeddedVersionRaw) }

// ------------------------------------------------------------------ paths and state

func rootDir() string {
	if d := os.Getenv("DFT_ROOT"); d != "" {
		return d
	}
	return defaultRoot()
}
func appRoot() string        { return filepath.Join(rootDir(), "app") }
func appDir(v string) string { return filepath.Join(appRoot(), v) }
func installedExe() string   { return filepath.Join(rootDir(), exeName) }
func statePath() string      { return filepath.Join(rootDir(), "state.json") }
func logDir() string         { return filepath.Join(rootDir(), "logs") }
func runningPath() string    { return filepath.Join(rootDir(), "running.json") }
func updateNotePath() string { return filepath.Join(rootDir(), "update-note.json") }

type State struct {
	Current  string   `json:"current"`
	Previous string   `json:"previous,omitempty"`
	Bad      []string `json:"bad,omitempty"`
}

func loadState() State {
	var s State
	if b, err := os.ReadFile(statePath()); err == nil {
		_ = json.Unmarshal(b, &s)
	}
	return s
}
func saveState(s State) error {
	b, _ := json.MarshalIndent(s, "", "  ")
	return writeAtomic(statePath(), b)
}
func writeAtomic(path string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
func (s State) isBad(v string) bool {
	for _, b := range s.Bad {
		if b == v {
			return true
		}
	}
	return false
}
func versionReady(v string) bool {
	if v == "" {
		return false
	}
	_, err := os.Stat(filepath.Join(appDir(v), ".complete"))
	return err == nil
}

// ------------------------------------------------------------------ log

func logf(format string, a ...any) {
	_ = os.MkdirAll(logDir(), 0o755)
	p := filepath.Join(logDir(), "launcher.log")
	if st, err := os.Stat(p); err == nil && st.Size() > 512*1024 {
		_ = os.Rename(p, p+".1")
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s [%s] %s\n", time.Now().Format("2006-01-02 15:04:05"), launcherVersion, fmt.Sprintf(format, a...))
}

// ------------------------------------------------------------------ versions

func semverCmp(a, b string) int {
	pa, pb := parseVer(a), parseVer(b)
	for i := 0; i < 3; i++ {
		if pa[i] != pb[i] {
			if pa[i] < pb[i] {
				return -1
			}
			return 1
		}
	}
	return 0
}
func parseVer(v string) [3]int {
	var out [3]int
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	for i, p := range strings.SplitN(v, ".", 3) {
		n, _ := strconv.Atoi(p)
		out[i] = n
	}
	return out
}

var verRe = regexp.MustCompile(`^\d+\.\d+\.\d+$`)

// ------------------------------------------------------------------ unpacking an app version

// unzipTo unpacks a zip into a new folder app\<version>, through a temporary folder, so a half-written version never
// looks ready. Paths that would escape the folder are refused.
func installAppZip(data []byte, version string) error {
	if !verRe.MatchString(version) {
		return fmt.Errorf("bad version %q", version)
	}
	if versionReady(version) {
		return nil
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return err
	}
	if err := os.MkdirAll(appRoot(), 0o755); err != nil {
		return err
	}
	tmp, err := os.MkdirTemp(appRoot(), ".tmp-"+version+"-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	var total int64
	for _, f := range zr.File {
		name := filepath.FromSlash(f.Name)
		if name == "" || filepath.IsAbs(name) || strings.HasPrefix(filepath.Clean(name), "..") || strings.Contains(f.Name, "\\") {
			return fmt.Errorf("unsafe path in update: %q", f.Name)
		}
		dst := filepath.Join(tmp, name)
		if !strings.HasPrefix(dst, tmp+string(os.PathSeparator)) {
			return fmt.Errorf("unsafe path in update: %q", f.Name)
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(dst, 0o755); err != nil {
				return err
			}
			continue
		}
		total += int64(f.UncompressedSize64)
		if total > 500<<20 {
			return errors.New("update too large")
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
		if err != nil {
			rc.Close()
			return err
		}
		_, err = io.Copy(out, io.LimitReader(rc, 500<<20))
		rc.Close()
		if cerr := out.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			return err
		}
	}
	if err := os.WriteFile(filepath.Join(tmp, ".complete"), []byte(version), 0o644); err != nil {
		return err
	}
	final := appDir(version)
	_ = os.RemoveAll(final) // an incomplete leftover
	return os.Rename(tmp, final)
}

// prune keeps the current and previous versions (and whatever the panel runs right now) and deletes the rest.
func prune(s State) {
	keep := map[string]bool{s.Current: true, s.Previous: true}
	if r, ok := readRunning(); ok {
		keep[r.Version] = true
	}
	entries, _ := os.ReadDir(appRoot())
	for _, e := range entries {
		n := e.Name()
		if keep[n] {
			continue
		}
		if strings.HasPrefix(n, ".tmp-") {
			if info, err := e.Info(); err == nil && time.Since(info.ModTime()) < 30*time.Minute {
				continue // another update may be writing it
			}
		}
		_ = os.RemoveAll(filepath.Join(appRoot(), n))
	}
}

// ------------------------------------------------------------------ the running panel

type Running struct {
	Pid     int    `json:"pid"`
	URL     string `json:"url"`
	Version string `json:"version"`
}

func readRunning() (Running, bool) {
	var r Running
	b, err := os.ReadFile(runningPath())
	if err != nil || json.Unmarshal(b, &r) != nil || r.Pid <= 0 || r.URL == "" {
		return r, false
	}
	return r, processAlive(r.Pid)
}

// ------------------------------------------------------------------ install

func isInstalledCopy() bool {
	self, err := os.Executable()
	if err != nil {
		return false
	}
	if s, err := filepath.EvalSymlinks(self); err == nil {
		self = s
	}
	return samePath(filepath.Dir(self), rootDir())
}

func install() error {
	logf("installing to %s", rootDir())
	if err := os.MkdirAll(appRoot(), 0o755); err != nil {
		return err
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	if err := copySelfTo(self, installedExe()); err != nil {
		return fmt.Errorf("could not copy the launcher: %w", err)
	}
	st := loadState()
	ev := embeddedVersion()
	if st.Current == "" || semverCmp(ev, st.Current) > 0 || !versionReady(st.Current) {
		if err := installAppZip(embeddedApp, ev); err != nil {
			return fmt.Errorf("could not unpack the app: %w", err)
		}
		if st.Current != "" && st.Current != ev && versionReady(st.Current) {
			st.Previous = st.Current
		}
		st.Current = ev
		if err := saveState(st); err != nil {
			return err
		}
	}
	if err := createShortcuts(installedExe()); err != nil {
		logf("shortcuts: %v", err)
	}
	if err := registerUninstall(installedExe(), st.Current); err != nil {
		logf("apps & features entry: %v", err)
	}
	prune(st)
	return nil
}

// copySelfTo puts this exe at dst. A launcher already there may be running (Windows lets a running exe be renamed,
// not overwritten), so the old one is moved aside first.
func copySelfTo(self, dst string) error {
	if samePath(self, dst) {
		return nil
	}
	data, err := os.ReadFile(self)
	if err != nil {
		return err
	}
	if _, err := os.Stat(dst); err == nil {
		old := strings.TrimSuffix(dst, filepath.Ext(dst)) + ".old" + filepath.Ext(dst)
		_ = os.Remove(old)
		if err := os.Rename(dst, old); err != nil {
			return err
		}
	}
	if err := os.WriteFile(dst+".tmp", data, 0o755); err != nil {
		return err
	}
	return os.Rename(dst+".tmp", dst)
}

// ------------------------------------------------------------------ launch

func launch(noUpdate bool) {
	cleanupOldExe()
	if r, ok := readRunning(); ok && pingPanel(r.URL) {
		logf("panel already running (pid %d): showing its window", r.Pid)
		openAppWindow(r.URL)
		return
	}
	if !noUpdate {
		res := stageUpdate(8*time.Second, 25*time.Second)
		logf("update check: %s", res.summary())
		if res.LauncherUpdated {
			// the new launcher takes it from here
			if err := startDetached(installedExe(), []string{"--no-update"}); err == nil {
				return
			}
		}
	}
	for attempt := 0; attempt < 2; attempt++ {
		st := loadState()
		v := st.Current
		if !versionReady(v) {
			if versionReady(st.Previous) {
				v = st.Previous
			} else {
				ev := embeddedVersion()
				if err := installAppZip(embeddedApp, ev); err != nil {
					fatal("DF Trainer could not unpack its files.\n\n" + err.Error())
				}
				v = ev
			}
			st.Current = v
			_ = saveState(st)
		}
		url, err := startPanel(v)
		if err == nil {
			openAppWindow(url) // returns when the window is closed
			return
		}
		logf("version %s did not start: %v", v, err)
		if errors.Is(err, errNoNode) {
			fatal("Node.js was not found.\n\nOpen the Dauntless Forever launcher, pick 1.6.2 and run its Set up once (it installs Node.js), then open DF Trainer again.")
		}
		// a version that does not start is never used again: back to the one before
		st = loadState()
		if st.Previous != "" && st.Previous != v && versionReady(st.Previous) {
			st.Bad = append(st.Bad, v)
			st.Current, st.Previous = st.Previous, ""
			_ = saveState(st)
			_ = writeAtomic(updateNotePath(), mustJSON(map[string]any{"rolledBack": v, "to": st.Current, "at": time.Now().Unix()}))
			logf("rolled back from %s to %s", v, st.Current)
			continue
		}
		fatal("DF Trainer could not start.\n\n" + err.Error() + "\n\nThe details are in " + filepath.Join(logDir(), "panel.log"))
	}
}

var errNoNode = errors.New("node.js not found")
var urlRe = regexp.MustCompile(`DF Trainer panel: (http://127\.0\.0\.1:\d+/\?t=[0-9a-f]+)`)

func startPanel(v string) (string, error) {
	node := findNode()
	if node == "" {
		return "", errNoNode
	}
	dir := appDir(v)
	_ = os.MkdirAll(logDir(), 0o755)
	logPath := filepath.Join(logDir(), "panel.log")
	lf, err := os.Create(logPath)
	if err != nil {
		return "", err
	}
	cmd := exec.Command(node, filepath.Join(dir, "server.js"))
	cmd.Dir = dir
	cmd.Stdout, cmd.Stderr = lf, lf
	cmd.Env = append(os.Environ(),
		"DFT_ROOT="+rootDir(), "DFT_LAUNCHER="+installedExe(), "DFT_VERSION="+v, "DFT_LAUNCHER_VERSION="+launcherVersion)
	hideAndDetach(cmd)
	if err := cmd.Start(); err != nil {
		lf.Close()
		return "", err
	}
	lf.Close()
	pid := cmd.Process.Pid
	_ = cmd.Process.Release()
	logf("started panel %s with %s (pid %d)", v, node, pid)
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(120 * time.Millisecond)
		b, _ := os.ReadFile(logPath)
		if m := urlRe.FindSubmatch(b); m != nil {
			return string(m[1]), nil
		}
		if !processAlive(pid) {
			return "", fmt.Errorf("the panel stopped: %s", lastLines(string(b), 6))
		}
	}
	b, _ := os.ReadFile(logPath)
	killProcess(pid)
	return "", fmt.Errorf("the panel did not answer in time: %s", lastLines(string(b), 6))
}

func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

// findNode: the Node.js Dauntless Forever's set-up recorded (config.json of the 1.6.2 package), then one on PATH.
func findNode() string {
	if n := os.Getenv("DFT_NODE"); n != "" && fileExists(n) {
		return n
	}
	var pkgs []string
	var st struct {
		Package string `json:"package"`
	}
	if b, err := os.ReadFile(filepath.Join(rootDir(), "trainer-settings.json")); err == nil && json.Unmarshal(b, &st) == nil && st.Package != "" {
		pkgs = append(pkgs, st.Package)
	}
	if la := os.Getenv("LOCALAPPDATA"); la != "" {
		pkgs = append(pkgs, filepath.Join(la, "DauntlessForever", "versions", "1.6.2"), filepath.Join(la, "DauntlessOffline", "versions", "1.6.2"))
	}
	if p := os.Getenv("DF_PACKAGE"); p != "" {
		pkgs = append([]string{p}, pkgs...)
	}
	for _, p := range pkgs {
		var cfg struct {
			Node string `json:"Node"`
		}
		b, err := os.ReadFile(filepath.Join(p, "config.json"))
		if err != nil {
			continue
		}
		b = bytes.TrimPrefix(b, []byte("\xef\xbb\xbf"))
		if json.Unmarshal(b, &cfg) == nil && cfg.Node != "" && fileExists(cfg.Node) {
			return cfg.Node
		}
	}
	if p, err := exec.LookPath(nodeExeName); err == nil {
		return p
	}
	for _, p := range extraNodePaths() {
		if fileExists(p) {
			return p
		}
	}
	return ""
}

func fileExists(p string) bool { st, err := os.Stat(p); return err == nil && !st.IsDir() }
func mustJSON(v any) []byte    { b, _ := json.Marshal(v); return b }

func cleanupOldExe() {
	exe := installedExe()
	_ = os.Remove(strings.TrimSuffix(exe, filepath.Ext(exe)) + ".old" + filepath.Ext(exe))
}

func fatal(msg string) {
	logf("error: %s", strings.ReplaceAll(msg, "\n", " "))
	showError("DF Trainer", msg)
	os.Exit(1)
}

// ------------------------------------------------------------------ main

func main() {
	args := os.Args[1:]
	has := func(f string) bool {
		for _, a := range args {
			if a == f {
				return true
			}
		}
		return false
	}
	argAfter := func(f string) string {
		for i, a := range args {
			if a == f && i+1 < len(args) {
				return args[i+1]
			}
		}
		return ""
	}

	switch {
	case has("--version"):
		fmt.Printf("launcher %s, carries app %s\n", launcherVersion, embeddedVersion())
		return
	case has("--uninstall"):
		uninstall()
		return
	case has("--check"):
		os.Stdout.Write(mustJSON(checkOnly(15 * time.Second)))
		return
	case has("--stage"):
		os.Stdout.Write(mustJSON(stageUpdate(20*time.Second, 5*time.Minute)))
		return
	}

	if !isInstalledCopy() && os.Getenv("DFT_PORTABLE") == "" {
		if err := install(); err != nil {
			fatal("DF Trainer could not be installed.\n\n" + err.Error())
		}
		if has("--install-only") {
			return
		}
		if err := startDetached(installedExe(), []string{"--no-update"}); err != nil {
			fatal("DF Trainer was installed but could not start.\n\n" + err.Error())
		}
		return
	}
	if pid := argAfter("--after"); pid != "" {
		if n, err := strconv.Atoi(pid); err == nil {
			for i := 0; i < 100 && processAlive(n); i++ {
				time.Sleep(150 * time.Millisecond)
			}
		}
		_ = os.Remove(runningPath())
		waitWindowClosed()
	}
	launch(has("--no-update"))
}
