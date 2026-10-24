package main

import (
	"image"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"testing"
)

// go test -run TestOverlayFrames -args <dir> writes a few frames as PNG (for looking at the design)
func TestOverlayFrames(t *testing.T) {
	dir := os.Getenv("OVERLAY_PNG_DIR")
	st := ovStyle{Accent: "#3cebff", Light: "#4ff3ff", Deep: "#0b5f6d", Scale: 1, Opacity: 0.85, Parts: true, Numbers: true}
	b := &ovBeh{Key: "k1", Name: "Rogue Embermane", Cur: 15654, Max: 15654, Element: "Blaze", Weak: "Frost", Stagger: 3000, StaggerMax: 3000, Parts: []ovPart{
		{Name: "Head", Cur: f64(2400), Max: 2400}, {Name: "Left foreleg", Cur: f64(1800), Max: 1800}, {Name: "Right foreleg", Cur: f64(1800), Max: 1800}, {Name: "Tail", Cur: f64(1500), Max: 1500}, {Name: "Back", Cur: f64(2000), Max: 2000}}}
	m := &ovModel{}
	now := 0.0
	run := func(sec float64) {
		for i := 0; i < int(sec*60); i++ {
			now += 1.0 / 60
			m.step(now, 1.0/60)
		}
	}
	save := func(name string, u float64) {
		img := ovDraw(m, st, u)
		if img.Bounds().Dx() < 100 {
			t.Fatalf("%s: too small", name)
		}
		if dir == "" {
			return
		}
		f, _ := os.Create(filepath.Join(dir, name+".png"))
		defer f.Close()
		_ = png.Encode(f, img)
	}
	m.update(b, now)
	run(0.1)
	save("1-sweep", 1)
	run(1)
	save("2-full", 1)
	b.Cur, b.Parts[0].Cur, b.Parts[3].Cur, b.Stagger = 11200, f64(900), f64(0), 1700
	b.Parts[3].Breaks = 1
	m.update(b, now)
	run(0.12)
	save("3-hit", 1)
	run(1.5)
	save("4-after", 1)
	// the game refills a broken part at once: it stays BROKEN for the rest of the fight
	b.Parts[3].Cur, b.Parts[1].Cur, b.Parts[1].Breaks = f64(1500), f64(1800), 1
	m.update(b, now)
	run(0.5)
	if !m.parts[1].broken || !m.parts[3].broken {
		t.Fatal("a refilled break was not kept as broken")
	}
	save("4b-broken-held", 1)
	run(3)
	if m.parts[3].target != 0 || m.parts[3].disp > 0.001 {
		t.Fatalf("a broken part refilled to %.2f", m.parts[3].disp)
	}
	// the game's own break state (IsBroken), health untouched
	b.Parts[0].Broken = true
	m.update(b, now)
	run(1)
	if !m.parts[0].broken {
		t.Fatal("the game's break state was not taken")
	}
	// the game stops reporting a broken part: it stays on the card, broken
	b.Parts = b.Parts[1:]
	m.update(b, now)
	run(0.5)
	found := false
	for _, p := range m.parts {
		if p.name == "Head" && p.broken {
			found = true
		}
	}
	if !found {
		t.Fatal("a broken part the game stopped reporting vanished")
	}
	save("4c-broken-stays", 1)
	// stagger damage without a meter (what the game gave in 3.8): shown as a number, STAGGERED when it resets
	b.StaggerMax, b.Stagger, b.StaggerDmg = 0, 0, f64(0)
	m.update(b, now)
	b.StaggerDmg = f64(4250)
	m.update(b, now)
	run(0.8)
	if m.hasStag || !m.hasSDmg || m.sdDisp < 4249 {
		t.Fatalf("stagger damage not shown (%.0f)", m.sdDisp)
	}
	save("4d-stagger-damage", 1)
	b.StaggerDmg = f64(0)
	m.update(b, now)
	run(0.3)
	save("4e-staggered", 1)
	if m.now-m.staggeredAt > 1 {
		t.Fatal("a stagger was not shown")
	}
	run(2)
	b.StaggerMax, b.Stagger = 3000, 1700
	if m.disp < 0.70 || m.disp > 0.73 {
		t.Fatalf("health bar settled at %.3f", m.disp)
	}
	st.Parts, st.Numbers = false, false
	save("5-compact", 1)
	st.Parts, st.Numbers, st.Accent, st.Light, st.Deep = true, true, "#ff5c78", "#ff8399", "#7a1526"
	save("6-crimson-large", 1.4)
	b2 := &ovBeh{Key: "k2", Name: "Skarn", Cur: 30000, Max: 30000, Element: "Terra", Weak: "Shock", Parts: []ovPart{{Name: "Head", Cur: f64(900), Max: 900}}}
	m.update(b2, now)
	run(0.15)
	save("7-switching", 1)
	run(1.2)
	if m.key != "k2" {
		t.Fatal("did not switch behemoth")
	}
	if len(m.parts) != 1 || m.parts[0].broken {
		t.Fatal("a new behemoth did not start with fresh, unbroken parts")
	}
	b2.Cur, b2.Dead = 0, true
	m.update(b2, now)
	run(1)
	save("8-defeated", 1)
	m.update(nil, now)
	run(0.5)
	if m.alpha != 0 {
		t.Fatal("did not fade out")
	}
	_ = image.Rect
}

func f64(v float64) *float64 { return &v }

// the quest card: OVERLAY_PNG_DIR=<dir> go test -run TestQuestFrames writes frames as PNG
func TestQuestFrames(t *testing.T) {
	dir := os.Getenv("OVERLAY_PNG_DIR")
	st := ovStyle{Accent: "#3cebff", Light: "#4ff3ff", Deep: "#0b5f6d", Scale: 1, Opacity: 0.85}
	m := &qModel{}
	now := 0.0
	run := func(sec float64) {
		for i := 0; i < int(sec*60); i++ {
			now += 1.0 / 60
			m.step(now, 1.0/60)
		}
	}
	save := func(name string) {
		img := qDraw(m, st, 1)
		if dir == "" {
			return
		}
		f, _ := os.Create(filepath.Join(dir, "q"+name+".png"))
		defer f.Close()
		_ = png.Encode(f, img)
	}
	qs := []ovQuest{
		{Key: "a", Title: "A New Threat", Cat: "main", Obj: []ovQObj{{D: "Hunt a Shrike", C: f64(1), R: f64(3)}, {D: "Gather Aetherdust", C: f64(10), R: f64(10), Done: true}}},
		{Key: "b", Title: "Rumour: Umbral Helm", Cat: "rumour", Obj: []ovQObj{{D: "Break a Gnasher's tail", C: f64(0), R: f64(2)}}},
	}
	m.update(qs, now)
	run(0.1)
	save("1-in")
	run(1)
	save("2-shown")
	if len(m.quests) != 2 || m.quests[0].obj[0].target < 0.33 || m.quests[0].obj[0].target > 0.34 {
		t.Fatal("progress 1/3 not taken")
	}
	qs[0].Obj[0].C = f64(2)
	m.update(qs, now)
	run(0.1)
	save("3-progress")
	run(1)
	// the game gave no amount required: no "/X" and no bar, never a made-up total
	qs = append(qs, ovQuest{Key: "c", Title: "", Cat: "side", Obj: []ovQObj{{D: "Talk to Ozz", C: f64(1)}}})
	qs[1].Complete = true
	m.update(qs, now)
	run(0.3)
	save("4-complete-and-new")
	run(1.5)
	if m.quests[2].obj[0].hasReq {
		t.Fatal("an amount required was made up")
	}
	save("5-settled")
	m.update(qs[:1], now) // the rumour handed in, the side quest abandoned: both close out
	run(0.12)
	save("6-closing")
	run(1)
	if len(m.quests) != 1 {
		t.Fatalf("%d quests left after two went", len(m.quests))
	}
	save("7-one")
	st.Accent, st.Light, st.Deep = "#ff5c78", "#ff8399", "#7a1526"
	save("8-crimson")
	m.update(nil, now)
	run(0.6)
	if m.alpha != 0 {
		t.Fatal("did not fade out")
	}
}

// The tail-break bug as the overlay received it, and what it does with each kind of data:
//   - an old mod that missed the break sent the refilled health (1363/1363, then 800): a number, no break known
//   - the new mod sends the break (broken, health 0) and keeps sending it whatever the game puts in the health
//   - a reading that is missing (cur null) is shown as unknown, not as a number, and never undoes BROKEN
func TestTailBreakStaysBroken(t *testing.T) {
	m := &ovModel{}
	now := 0.0
	run := func(sec float64) {
		for i := 0; i < int(sec*60); i++ {
			now += 1.0 / 60
			m.step(now, 1.0/60)
		}
	}
	part := func(name string) *ovPartAnim {
		for _, p := range m.parts {
			if p.name == name {
				return p
			}
		}
		return nil
	}
	b := &ovBeh{Key: "lerawr", Name: "Rogue Embermane", Cur: 20000, Max: 20000, Parts: []ovPart{
		{Name: "Head", Cur: f64(1363), Max: 1363}, {Name: "Tail", Cur: f64(900), Max: 900}}}
	m.update(b, now)
	run(1)
	// the break: health 0 with the break flag
	b.Parts[1] = ovPart{Name: "Tail", Cur: f64(0), Max: 900, Broken: true}
	m.update(b, now)
	run(0.5)
	// what the game does next: a new health object (different numbers), more changes, a missing reading
	for _, next := range []ovPart{
		{Name: "Tail", Cur: f64(1363), Max: 1363, Broken: true},
		{Name: "Tail", Cur: f64(800), Max: 1363, Broken: true},
		{Name: "Tail", Cur: f64(1363), Max: 1363}, // even a reading without the flag (stale data)
		{Name: "Tail", Cur: nil, Max: 1363},       // no reading
		{Name: "Tail", Cur: f64(-5), Max: 1363},   // out of range
	} {
		b.Parts[1] = next
		m.update(b, now)
		run(0.4)
		p := part("Tail")
		if p == nil || !p.broken || p.target != 0 || p.disp > 0.01 {
			t.Fatalf("tail not BROKEN after %+v: %+v", next, p)
		}
	}
	// the tail missing from the data altogether: still on the card, broken
	b.Parts = b.Parts[:1]
	m.update(b, now)
	run(0.3)
	if p := part("Tail"); p == nil || !p.broken {
		t.Fatal("broken tail vanished")
	}
	// the head (intact) with no reading: unknown, not a number, and not broken
	b.Parts[0].Cur = nil
	m.update(b, now)
	run(0.3)
	if p := part("Head"); p == nil || !p.unknown || p.broken {
		t.Fatalf("head with no reading: %+v", p)
	}
	b.Parts[0].Cur = f64(700)
	m.update(b, now)
	run(1)
	if p := part("Head"); p.unknown || math.Abs(p.disp-700.0/1363) > 0.01 {
		t.Fatalf("head back to a real reading: %+v", p)
	}
	// a new encounter (another behemoth of the same kind): fresh, unbroken parts
	m.update(&ovBeh{Key: "lerawr2", Name: "Rogue Embermane", Cur: 20000, Max: 20000, Parts: []ovPart{{Name: "Tail", Cur: f64(900), Max: 900}}}, now)
	run(1.5)
	if p := part("Tail"); p == nil || p.broken || p.disp < 0.99 {
		t.Fatalf("new encounter did not start fresh: %+v", p)
	}
}
