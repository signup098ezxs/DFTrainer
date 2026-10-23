//go:build !windows

package main

// Non-Windows stand-ins, so the launcher's logic (install, updates, rollback) can be built and tested anywhere.
// DF Trainer itself only runs on Windows.

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

const (
	exeName     = "dftrainer"
	nodeExeName = "node"
)

func defaultRoot() string {
	h, _ := os.UserHomeDir()
	return filepath.Join(h, ".local", "share", "dftrainer")
}
func extraNodePaths() []string  { return nil }
func samePath(a, b string) bool { return filepath.Clean(a) == filepath.Clean(b) }

func processAlive(pid int) bool {
	if syscall.Kill(pid, 0) != nil {
		return false
	}
	// a finished child that nobody waited for is a zombie: not alive
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err == nil {
		for i := 0; i < len(b)-2; i++ {
			if b[i] == ')' {
				return b[i+2] != 'Z'
			}
		}
	}
	return true
}
func killProcess(pid int) { _ = syscall.Kill(pid, syscall.SIGKILL) }
func hideAndDetach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
func startDetached(exe string, args []string) error {
	cmd := exec.Command(exe, args...)
	cmd.Dir = filepath.Dir(exe)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}
func showError(title, text string)    { fmt.Fprintf(os.Stderr, "%s: %s\n", title, text) }
func showInfo(title, text string)     { fmt.Fprintf(os.Stdout, "%s: %s\n", title, text) }
func confirm(title, text string) bool { return os.Getenv("DFT_YES") == "1" }
func openAppWindow(url string) {
	logf("open window %s", url)
	_ = os.WriteFile(filepath.Join(rootDir(), "opened-window.txt"), []byte(url), 0o644)
}
func waitWindowClosed()                           {}
func createShortcuts(exe string) error            { logf("shortcuts for %s", exe); return nil }
func removeShortcuts()                            {}
func registerUninstall(exe, version string) error { return nil }
func unregisterUninstall()                        {}
func scheduleDelete(dir string)                   { _ = os.RemoveAll(dir) }
