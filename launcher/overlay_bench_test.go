package main

import "testing"

func benchModel() (*ovModel, ovStyle) {
	st := ovStyle{Accent: "#3cebff", Light: "#4ff3ff", Deep: "#0b5f6d", Scale: 1, Opacity: 0.85, Parts: true, Numbers: true}
	b := &ovBeh{Key: "k", Name: "Rogue Embermane", Cur: 11200, Max: 15654, Parts: []ovPart{
		{"Head", 900, 2400}, {"Left foreleg", 1800, 1800}, {"Right foreleg", 1700, 1800}, {"Tail", 0, 1500}, {"Back", 2000, 2000}, {"Left hind leg", 1500, 1800}}}
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
