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
	b := &ovBeh{Key: "k1", Name: "Rogue Embermane", Cur: 15654, Max: 15654, Parts: []ovPart{
		{"Head", 2400, 2400}, {"Left foreleg", 1800, 1800}, {"Right foreleg", 1800, 1800}, {"Tail", 1500, 1500}, {"Back", 2000, 2000}}}
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
	b.Cur, b.Parts[0].Cur, b.Parts[3].Cur = 11200, 900, 0
	m.update(b, now)
	run(0.12)
	save("3-hit", 1)
	run(1.5)
	save("4-after", 1)
	if m.disp < 0.70 || m.disp > 0.73 {
		t.Fatalf("health bar settled at %.3f", m.disp)
	}
	st.Parts, st.Numbers = false, false
	save("5-compact", 1)
	st.Parts, st.Numbers, st.Accent, st.Light, st.Deep = true, true, "#ff5c78", "#ff8399", "#7a1526"
	save("6-crimson-large", 1.4)
	b2 := &ovBeh{Key: "k2", Name: "Shrike", Cur: 30000, Max: 30000}
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
