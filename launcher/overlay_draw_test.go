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
	// the game refills a broken part at once: "Broken" stays a moment, then a break count shows by the name
	b.Parts[3].Cur, b.Parts[1].Cur, b.Parts[1].Breaks = 1500, 1800, 1
	m.update(b, now)
	run(0.5)
	if !(m.parts[1].brokeAt > 0) {
		t.Fatal("a refilled break was not noticed")
	}
	save("4b-broken-held", 1)
	run(3)
	save("4c-break-count", 1)
	if m.disp < 0.70 || m.disp > 0.73 {
		t.Fatalf("health bar settled at %.3f", m.disp)
	}
	st.Parts, st.Numbers = false, false
	save("5-compact", 1)
	st.Parts, st.Numbers, st.Accent, st.Light, st.Deep = true, true, "#ff5c78", "#ff8399", "#7a1526"
	save("6-crimson-large", 1.4)
	b2 := &ovBeh{Key: "k2", Name: "Skarn", Cur: 30000, Max: 30000, Element: "Terra", Weak: "Shock"}
	m.update(b2, now)
	run(0.15)
	save("7-switching", 1)
	run(1.2)
	if m.key != "k2" {
		t.Fatal("did not switch behemoth")
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
