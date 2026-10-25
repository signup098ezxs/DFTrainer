package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func fp(v float64) *float64 { return &v }

// 1.6.11: two quest objectives with the same text each keep their own progress (they shared one before)
func TestQuestObjectivesSameText(t *testing.T) {
	m := &qModel{}
	q := []ovQuest{{Key: "Q1", Title: "T", Obj: []ovQObj{{D: "", C: fp(1), R: fp(3)}, {D: "", C: fp(5), R: fp(5)}}}}
	for i := 0; i < 3; i++ {
		m.update(q, float64(i))
	}
	o := m.quests[0].obj
	if len(o) != 2 || o[0] == o[1] {
		t.Fatalf("objectives share one animation: %d objects", len(o))
	}
	if o[0].cur != 1 || o[1].cur != 5 {
		t.Fatalf("progress mixed up: %v and %v (want 1 and 5)", o[0].cur, o[1].cur)
	}
}

// 1.6.11: two parts with one name each keep their own bar and broken state
func TestPartsSameName(t *testing.T) {
	m := &ovModel{}
	ps := []ovPart{{Name: "Leg", Cur: fp(100), Max: 100}, {Name: "Leg", Cur: fp(0), Max: 100, Broken: true}}
	for i := 0; i < 3; i++ {
		m.setParts(ps, float64(i), i == 0)
	}
	if len(m.parts) != 2 || m.parts[0] == m.parts[1] {
		t.Fatalf("parts share one bar")
	}
	if m.parts[0].broken || !m.parts[1].broken {
		t.Fatalf("broken state mixed up: %v %v", m.parts[0].broken, m.parts[1].broken)
	}
}

// 1.6.11: a running update's lock is never taken over because it is old, and an update never removes a lock
// another update holds
func TestUpdateLockOwnership(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DFT_ROOT", dir)
	p := filepath.Join(dir, "update.lock")

	live := exec.Command("sleep", "5")
	if err := live.Start(); err != nil {
		t.Skip("no 'sleep' command")
	}
	defer live.Process.Kill()
	os.WriteFile(p, []byte(strconv.Itoa(live.Process.Pid)), 0o644)
	old := time.Now().Add(-10 * time.Minute)
	os.Chtimes(p, old, old)
	if _, ok := takeLock(); ok {
		t.Fatal("a 10-minute-old lock of a running update was taken over")
	}
	os.Remove(p)

	unlock, ok := takeLock()
	if !ok {
		t.Fatal("could not take a free lock")
	}
	// another update took the lock over meanwhile (its owner judged this one stale)
	os.WriteFile(p, []byte(strconv.Itoa(live.Process.Pid)), 0o644)
	unlock()
	if b, err := os.ReadFile(p); err != nil || string(b) != strconv.Itoa(live.Process.Pid) {
		t.Fatalf("releasing removed another update's lock (%q, %v)", b, err)
	}
	os.Remove(p)

	// a lock past an hour is stale whatever it holds (its process id may belong to something else by now)
	os.WriteFile(p, []byte(strconv.Itoa(live.Process.Pid)), 0o644)
	ancient := time.Now().Add(-2 * time.Hour)
	os.Chtimes(p, ancient, ancient)
	unlock, ok = takeLock()
	if !ok {
		t.Fatal("a 2-hour-old lock still blocked the update")
	}
	unlock()
}
