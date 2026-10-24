package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// The "Could not check for updates" bug: an update stopped part way left update.lock behind, and every update was
// refused for 15 minutes. A lock whose owner is gone is now cleared at once; a live owner's lock is respected.
func TestUpdateLock(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DFT_ROOT", dir)
	p := filepath.Join(dir, "update.lock")

	// left by a process that no longer runs (the killed --stage)
	dead := exec.Command("true")
	if err := dead.Run(); err != nil {
		t.Skip("no 'true' command")
	}
	os.WriteFile(p, []byte(strconv.Itoa(dead.Process.Pid)), 0o644)
	unlock, ok := takeLock()
	if !ok {
		t.Fatal("a lock left by a stopped update blocked the update")
	}
	b, _ := os.ReadFile(p)
	if string(b) != strconv.Itoa(os.Getpid()) {
		t.Fatalf("lock does not hold its owner: %q", b)
	}
	// a second update while this one runs: refused
	if _, ok := takeLock(); ok {
		t.Fatal("two updates at once")
	}
	unlock()
	if _, err := os.Stat(p); err == nil {
		t.Fatal("lock not removed")
	}

	// held by a process that is running: respected
	live := exec.Command("sleep", "5")
	if err := live.Start(); err != nil {
		t.Skip("no 'sleep' command")
	}
	defer live.Process.Kill()
	os.WriteFile(p, []byte(strconv.Itoa(live.Process.Pid)), 0o644)
	if _, ok := takeLock(); ok {
		t.Fatal("a running update's lock was taken over")
	}
	os.Remove(p)

	// an old launcher's empty lock: respected while recent, cleared when older than any update
	os.WriteFile(p, nil, 0o644)
	if _, ok := takeLock(); ok {
		t.Fatal("a fresh lock from an older launcher was taken over")
	}
	old := time.Now().Add(-8 * time.Minute)
	os.Chtimes(p, old, old)
	unlock, ok = takeLock()
	if !ok {
		t.Fatal("an 8-minute-old empty lock still blocked the update")
	}
	unlock()
}
