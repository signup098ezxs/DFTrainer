package main

import (
	"runtime"
	"testing"
)

// bytes allocated per frame while the card animates (parts appear, the card grows), health and quest cards
func TestOverlayAllocPerFrame(t *testing.T) {
	st := ovStyle{Accent: "#3cebff", Light: "#4ff3ff", Deep: "#0b5f6d", Scale: 1, Opacity: 0.85, Parts: true, Numbers: true}
	m := &ovModel{}
	q := &qModel{}
	b := &ovBeh{Key: "k", Name: "Rogue Embermane", Cur: 11200, Max: 15654}
	m.update(b, 0)
	frames := 0
	var ms0, ms1 runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&ms0)
	tm := 0.0
	for i := 0; i < 600; i++ {
		tm += 1.0 / 60
		if i%40 == 0 && i/40 < 8 { // a new part every 40 frames: the card changes size
			b.Parts = append(b.Parts, ovPart{Name: "Part " + string(rune('A'+i/40)), Cur: f64(100), Max: 200})
			m.update(b, tm)
			q.update([]ovQuest{{Key: "Q", Title: "Quest", Obj: make([]ovQObj, i/40+1)}}, tm)
		}
		if i%3 == 0 { // health ticks down
			b.Cur -= 7
			m.update(b, tm)
		}
		m.step(tm, 1.0/60)
		q.step(tm, 1.0/60)
		_ = ovDraw(m, st, 1)
		_ = qDraw(q, st, 1)
		frames++
	}
	runtime.ReadMemStats(&ms1)
	t.Logf("%d frames: %.1f KB allocated per frame, %d allocations per frame", frames, float64(ms1.TotalAlloc-ms0.TotalAlloc)/float64(frames)/1024, (ms1.Mallocs-ms0.Mallocs)/uint64(frames))
}
