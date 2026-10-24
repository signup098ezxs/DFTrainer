package main

import (
	"image"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

// go test -run TestOverlayFrames -args <dir> writes a few frames as PNG (for looking at the design)
func TestOverlayFrames(t *testing.T) {
	dir := os.Getenv("OVERLAY_PNG_DIR")
	st := ovStyle{Accent: "#3cebff", Light: "#4ff3ff", Deep: "#0b5f6d", Scale: 1, Opacity: 0.85, Parts: true, Numbers: true}
	b := &ovBeh{Key: "k1", Name: "Rogue Embermane", Cur: 15654, Max: 15654, Element: "Blaze", Weak: "Frost", Stagger: 3000, StaggerMax: 3000, Parts: []ovPart{
		{Name: "Head", Cur: 2400, Max: 2400}, {Name: "Left foreleg", Cur: 1800, Max: 1800}, {Name: "Right foreleg", Cur: 1800, Max: 1800}, {Name: "Tail", Cur: 1500, Max: 1500}, {Name: "Back", Cur: 2000, Max: 2000}}}
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
	b.Cur, b.Parts[0].Cur, b.Parts[3].Cur, b.Stagger = 11200, 900, 0, 1700
	b.Parts[3].Breaks = 1
	m.update(b, now)
	run(0.12)
	save("3-hit", 1)
	run(1.5)
	save("4-after", 1)
	// the game refills a broken part at once: it stays BROKEN for the rest of the fight
	b.Parts[3].Cur, b.Parts[1].Cur, b.Parts[1].Breaks = 1500, 1800, 1
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
	if m.disp < 0.70 || m.disp > 0.73 {
		t.Fatalf("health bar settled at %.3f", m.disp)
	}
	st.Parts, st.Numbers = false, false
	save("5-compact", 1)
	st.Parts, st.Numbers, st.Accent, st.Light, st.Deep = true, true, "#ff5c78", "#ff8399", "#7a1526"
	save("6-crimson-large", 1.4)
	b2 := &ovBeh{Key: "k2", Name: "Skarn", Cur: 30000, Max: 30000, Element: "Terra", Weak: "Shock", Parts: []ovPart{{Name: "Head", Cur: 900, Max: 900}}}
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
