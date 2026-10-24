package main

import "testing"

func benchModel() (*ovModel, ovStyle) {
	st := ovStyle{Accent: "#3cebff", Light: "#4ff3ff", Deep: "#0b5f6d", Scale: 1, Opacity: 0.85, Parts: true, Numbers: true}
	b := &ovBeh{Key: "k", Name: "Rogue Embermane", Cur: 11200, Max: 15654, Parts: []ovPart{
		{Name: "Head", Cur: f64(900), Max: 2400}, {Name: "Left foreleg", Cur: f64(1800), Max: 1800}, {Name: "Right foreleg", Cur: f64(1700), Max: 1800}, {Name: "Tail", Cur: f64(0), Max: 1500}, {Name: "Back", Cur: f64(2000), Max: 2000}, {Name: "Left hind leg", Cur: f64(1500), Max: 1800}}}
	m := &ovModel{}
	m.update(b, 0)
	for i := 0; i < 120; i++ {
		m.step(float64(i)/60, 1.0/60)
	}
	return m, st
}

// one animation frame at 1080p and at 1440p (u = 1.33)
func BenchmarkOverlayFrame1080(b *testing.B) {
	m, st := benchModel()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = ovDraw(m, st, 1)
	}
}
func BenchmarkOverlayFrame1440(b *testing.B) {
	m, st := benchModel()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = ovDraw(m, st, 1.333)
	}
}
