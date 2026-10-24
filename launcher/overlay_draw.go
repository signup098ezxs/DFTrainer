package main

// The behemoth overlay's picture: what it shows and how it moves, drawn in plain Go into a premultiplied RGBA image
// (overlay_windows.go puts that image on screen over the game). No Windows calls here, so it is tested anywhere.
//
// Look: the panel's own style. A dark glass card with a hairline in the colour preset, the behemoth's name in
// Chakra Petch (the panel's heading font), its health as the thick bar in the preset's colours, and its parts as thin
// neutral bars in two columns underneath, so the two never look alike. A hit pushes the bar down at once and leaves a
// pale "damage trail" that drains after a moment; a new behemoth sweeps in, a gone one fades out.

import (
	_ "embed"
	"fmt"
	"image"
	"math"
	"strings"
	"sync"

	"dftrainer/launcher/internal/third_party/ximage/font"
	"dftrainer/launcher/internal/third_party/ximage/font/opentype"
	"dftrainer/launcher/internal/third_party/ximage/math/fixed"
)

//go:embed fonts/ChakraPetch-SemiBold.ttf
var fontSemiTTF []byte

//go:embed fonts/ChakraPetch-Bold.ttf
var fontBoldTTF []byte

// ------------------------------------------------------------------ data from the panel (GET /api/overlay/state)

type ovPart struct {
	Name string  `json:"name"`
	Cur  float64 `json:"cur"`
	Max  float64 `json:"max"`
	// times this part has broken this fight: the game often refills a broken part at once (it can break again)
	Breaks int `json:"breaks"`
}
type ovBeh struct {
	Key   string   `json:"key"`
	Name  string   `json:"name"`
	Cur   float64  `json:"cur"`
	Max   float64  `json:"max"`
	Dead  bool     `json:"dead"`
	Parts []ovPart `json:"parts"`
	// its element and what it is weak to ("" when not known), and its stagger meter (max 0: not known)
	Element    string  `json:"element"`
	Weak       string  `json:"weak"`
	Stagger    float64 `json:"stagger"`
	StaggerMax float64 `json:"staggerMax"`
	// Lock: the part the Repeaters lock-on is holding your aim on ("" when it is not locked)
	Lock string `json:"lock"`
}
type ovStyle struct {
	Accent  string  `json:"accent"`
	Light   string  `json:"light"`
	Deep    string  `json:"deep"`
	Pos     string  `json:"pos"`
	Scale   float64 `json:"scale"`
	Opacity float64 `json:"opacity"`
	Parts   bool    `json:"parts"`
	Numbers bool    `json:"numbers"`
}

const ovMaxParts = 12

// ------------------------------------------------------------------ animation model

type ovPartAnim struct {
	name                   string
	cur, max               float64
	target, disp, ghost    float64
	ghostHold, flash, born float64
	breaks                 int
	brokeAt                float64 // when it last broke: "Broken" stays readable for a moment even if it refills
}

type ovModel struct {
	key, name                      string
	cur, max                       float64
	dead                           bool
	target, disp, ghost, ghostHold float64
	flash                          float64
	parts                          []*ovPartAnim
	alpha, alphaTarget             float64
	pending                        *ovBeh
	hasPending                     bool
	now                            float64
	element, weak                  string
	// stagger: shown as how close the behemoth is to being staggered. Whether the game's meter fills up or drains
	// with hits is taken from the meter itself (full at the start: it drains).
	hasStag, stagDrains                   bool
	sTarget, sDisp, sGhost, sHold, sFlash float64
	lock                                  string
}

func frac(cur, max float64) float64 {
	if max <= 0 {
		return 0
	}
	return math.Max(0, math.Min(1, cur/max))
}

// adopt: a behemoth shown fresh, its bars sweeping up from empty
func (m *ovModel) adopt(b *ovBeh, now float64) {
	m.key, m.name, m.cur, m.max, m.dead = b.Key, b.Name, b.Cur, b.Max, b.Dead
	m.target, m.disp, m.ghost, m.ghostHold, m.flash = frac(b.Cur, b.Max), 0, 0, 0, 0
	m.parts = nil
	m.setParts(b.Parts, now, true)
	m.element, m.weak, m.lock = b.Element, b.Weak, b.Lock
	m.hasStag, m.stagDrains = b.StaggerMax > 0, b.StaggerMax > 0 && b.Stagger >= b.StaggerMax*0.999
	m.sTarget, m.sDisp, m.sGhost, m.sHold, m.sFlash = m.stagProgress(b), 0, 0, 0, 0
	m.alphaTarget = 1
}

func (m *ovModel) stagProgress(b *ovBeh) float64 {
	f := frac(b.Stagger, b.StaggerMax)
	if m.stagDrains {
		return 1 - f
	}
	return f
}

func (m *ovModel) setStagger(b *ovBeh, now float64) {
	if b.StaggerMax <= 0 {
		m.hasStag = false
		return
	}
	if !m.hasStag {
		m.hasStag, m.stagDrains = true, b.Stagger >= b.StaggerMax*0.999
	}
	f := m.stagProgress(b)
	if f > m.sTarget+1e-6 {
		m.sHold, m.sFlash = now+0.4, 1
	}
	if f < m.sGhost {
		m.sGhost = f // stagger spent or reset: no trail
	}
	m.sTarget = f
}

func (m *ovModel) setParts(ps []ovPart, now float64, fresh bool) {
	if len(ps) > ovMaxParts {
		ps = ps[:ovMaxParts]
	}
	old := map[string]*ovPartAnim{}
	for _, p := range m.parts {
		old[p.name] = p
	}
	out := make([]*ovPartAnim, 0, len(ps))
	for _, p := range ps {
		f := frac(p.Cur, p.Max)
		a := old[p.Name]
		if a == nil {
			a = &ovPartAnim{name: p.Name, born: now, breaks: p.Breaks} // breaks from before it was shown: counted, not flashed
			if fresh {
				a.born = now - 1 // shown with the card: they sweep in with it
			} else {
				a.disp, a.ghost = f, f // a part found mid-fight: no sweep, just a fade in
			}
		} else if f < a.target-1e-6 {
			a.ghostHold, a.flash = now+0.45, 1
		}
		if f > a.ghost {
			a.ghost = f
		}
		if p.Breaks > a.breaks {
			a.brokeAt = now
		}
		a.breaks = p.Breaks
		a.cur, a.max, a.target = p.Cur, p.Max, f
		out = append(out, a)
	}
	m.parts = out
}

// update takes the latest data (nil: nothing to show)
func (m *ovModel) update(b *ovBeh, now float64) {
	switch {
	case b == nil:
		m.alphaTarget, m.hasPending = 0, false
	case m.key == "" || (m.alpha < 0.02 && b.Key != m.key):
		m.hasPending = false
		m.adopt(b, now)
	case b.Key != m.key: // another behemoth: fade this one out, then the new one in
		cp := *b
		m.pending, m.hasPending, m.alphaTarget = &cp, true, 0
	default:
		f := frac(b.Cur, b.Max)
		if f < m.target-1e-6 {
			m.ghostHold, m.flash = now+0.5, 1
		}
		if f > m.ghost {
			m.ghost = f
		}
		m.name, m.cur, m.max, m.dead, m.target = b.Name, b.Cur, b.Max, b.Dead, f
		m.element, m.weak, m.lock = b.Element, b.Weak, b.Lock
		m.setParts(b.Parts, now, false)
		m.setStagger(b, now)
		m.alphaTarget, m.hasPending = 1, false
	}
}

func approach(v, to, dt, tau float64) float64 { return v + (to-v)*(1-math.Exp(-dt/tau)) }

// step moves everything on by dt seconds; true while anything still moves
func (m *ovModel) step(now, dt float64) bool {
	m.now = now
	moving := false
	if m.alpha != m.alphaTarget {
		d := dt / 0.22
		if m.alphaTarget > m.alpha {
			m.alpha = math.Min(m.alphaTarget, m.alpha+d)
		} else {
			m.alpha = math.Max(m.alphaTarget, m.alpha-d)
		}
		moving = true
	}
	if m.hasPending && m.alpha <= 0.001 {
		m.hasPending = false
		m.adopt(m.pending, now)
		moving = true
	}
	bar := func(disp, ghost, target, hold, flash *float64) {
		tau := 0.09
		if *disp < *target-0.25 {
			tau = 0.2 // the sweep in
		}
		*disp = approach(*disp, *target, dt, tau)
		if now >= *hold {
			*ghost = approach(*ghost, *disp, dt, 0.2)
		}
		if *ghost < *disp {
			*ghost = *disp
		}
		*flash *= math.Exp(-dt / 0.14)
		if math.Abs(*disp-*target) > 0.0005 || *ghost-*disp > 0.0005 || *flash > 0.01 {
			moving = true
		} else {
			*disp, *ghost, *flash = *target, *target, 0
		}
	}
	bar(&m.disp, &m.ghost, &m.target, &m.ghostHold, &m.flash)
	if m.hasStag { // it fills: the trail sits behind the new value instead of ahead of it
		m.sDisp = approach(m.sDisp, m.sTarget, dt, 0.1)
		if now >= m.sHold {
			m.sGhost = approach(m.sGhost, m.sDisp, dt, 0.25)
		}
		if m.sGhost > m.sDisp {
			m.sGhost = m.sDisp
		}
		m.sFlash *= math.Exp(-dt / 0.14)
		if math.Abs(m.sDisp-m.sTarget) > 0.0005 || m.sDisp-m.sGhost > 0.0005 || m.sFlash > 0.01 {
			moving = true
		} else {
			m.sDisp, m.sGhost, m.sFlash = m.sTarget, m.sTarget, 0
		}
	}
	for _, p := range m.parts {
		bar(&p.disp, &p.ghost, &p.target, &p.ghostHold, &p.flash)
		if now-p.born < 0.3 {
			moving = true
		}
	}
	return moving
}

// ------------------------------------------------------------------ drawing

type rgbf struct{ r, g, b float64 }

func hexColor(s string, def rgbf) rgbf {
	var r, g, b uint8
	if n, _ := fmt.Sscanf(strings.TrimPrefix(s, "#"), "%02x%02x%02x", &r, &g, &b); n != 3 {
		return def
	}
	return rgbf{float64(r) / 255, float64(g) / 255, float64(b) / 255}
}
func mix(a, b rgbf, t float64) rgbf {
	return rgbf{a.r + (b.r-a.r)*t, a.g + (b.g-a.g)*t, a.b + (b.b-a.b)*t}
}

type canvas struct {
	img *image.RGBA
	w   int
	h   int
	fa  float64 // whole-card fade
}

func (c *canvas) blend(x, y int, col rgbf, a float64) {
	if x < 0 || y < 0 || x >= c.w || y >= c.h {
		return
	}
	a *= c.fa
	if a <= 0 {
		return
	}
	if a > 1 {
		a = 1
	}
	ai := uint32(a*255 + 0.5)
	if ai == 0 {
		return
	}
	ia := 255 - ai
	i := y*c.img.Stride + x*4
	p := c.img.Pix[i : i+4 : i+4]
	p[0] = uint8((uint32(col.r*255+0.5)*ai + uint32(p[0])*ia + 127) / 255)
	p[1] = uint8((uint32(col.g*255+0.5)*ai + uint32(p[1])*ia + 127) / 255)
	p[2] = uint8((uint32(col.b*255+0.5)*ai + uint32(p[2])*ia + 127) / 255)
	p[3] = uint8((255*ai + uint32(p[3])*ia + 127) / 255)
}

// sdRound: signed distance from (px,py) to a rounded rectangle (negative inside)
func sdRound(px, py, x, y, w, h, r float64) float64 {
	cx, cy := x+w/2, y+h/2
	qx, qy := math.Abs(px-cx)-(w/2-r), math.Abs(py-cy)-(h/2-r)
	ox, oy := math.Max(qx, 0), math.Max(qy, 0)
	return math.Hypot(ox, oy) + math.Min(math.Max(qx, qy), 0) - r
}

// rrect fills a rounded rectangle (anti-aliased); colAt gives the colour across it (0..1), alphaAt its alpha
func (c *canvas) rrect(x, y, w, h, r float64, colAt func(t float64) rgbf, a float64, alphaAt func(t float64) float64) {
	if w <= 0 || h <= 0 {
		return
	}
	r = math.Min(r, math.Min(w, h)/2)
	x0, y0 := int(math.Floor(x-1)), int(math.Floor(y-1))
	x1, y1 := int(math.Ceil(x+w+1)), int(math.Ceil(y+h+1))
	// pixels at least half a pixel inside the straight parts are fully covered: no distance maths for them
	rm := math.Max(r, 0.5)
	for py := y0; py <= y1; py++ {
		fy := float64(py) + 0.5
		rowA := fy >= y+rm && fy <= y+h-rm   // between the corners vertically
		rowB := fy >= y+0.5 && fy <= y+h-0.5 // inside the top and bottom edges
		for px := x0; px <= x1; px++ {
			fx := float64(px) + 0.5
			cov := 1.0
			if !((rowA && fx >= x+0.5 && fx <= x+w-0.5) || (rowB && fx >= x+rm && fx <= x+w-rm)) {
				d := sdRound(fx, fy, x, y, w, h, r)
				cov = math.Max(0, math.Min(1, 0.5-d))
				if cov <= 0 {
					continue
				}
			}
			t := (float64(px) + 0.5 - x) / w
			aa := a
			if alphaAt != nil {
				aa *= alphaAt(t)
			}
			c.blend(px, py, colAt(t), aa*cov)
		}
	}
}
func flat(col rgbf) func(float64) rgbf { return func(float64) rgbf { return col } }

// ring draws a rounded rectangle's 1-pixel outline
func (c *canvas) ring(x, y, w, h, r float64, col rgbf, a float64) {
	x0, y0 := int(math.Floor(x-1)), int(math.Floor(y-1))
	x1, y1 := int(math.Ceil(x+w+1)), int(math.Ceil(y+h+1))
	for py := y0; py <= y1; py++ {
		for px := x0; px <= x1; px++ {
			d := math.Abs(sdRound(float64(px)+0.5, float64(py)+0.5, x, y, w, h, r) + 0.5)
			cov := math.Max(0, math.Min(1, 1-d))
			if cov > 0 {
				c.blend(px, py, col, a*cov)
			}
		}
	}
}

// ------------------------------------------------------------------ text

var (
	fontOnce        sync.Once
	fontSemi, fontB *opentype.Font
	faceMu          sync.Mutex
	faces           = map[[2]int]font.Face{}
)

func ovFace(bold bool, px float64) font.Face {
	fontOnce.Do(func() {
		fontSemi, _ = opentype.Parse(fontSemiTTF)
		fontB, _ = opentype.Parse(fontBoldTTF)
	})
	k := [2]int{0, int(px*4 + 0.5)}
	f := fontSemi
	if bold {
		k[0], f = 1, fontB
	}
	faceMu.Lock()
	defer faceMu.Unlock()
	if fc, ok := faces[k]; ok {
		return fc
	}
	fc, err := opentype.NewFace(f, &opentype.FaceOptions{Size: float64(k[1]) / 4, DPI: 72, Hinting: font.HintingNone})
	if err != nil {
		return nil
	}
	faces[k] = fc
	return fc
}

func textWidth(f font.Face, s string) float64 {
	if f == nil {
		return 0
	}
	return float64(font.MeasureString(f, s)) / 64
}

// fit shortens s with "..." until it fits w
func fit(f font.Face, s string, w float64) string {
	if textWidth(f, s) <= w {
		return s
	}
	r := []rune(s)
	for len(r) > 1 {
		r = r[:len(r)-1]
		if t := strings.TrimRight(string(r), " ") + "…"; textWidth(f, t) <= w {
			return t
		}
	}
	return "…"
}

// rendered text (coverage masks), kept between frames: names, labels and most numbers repeat frame after frame
type textMask struct {
	px     []uint8
	w, h   int
	dx, dy int
}

var (
	textMu    sync.Mutex
	textCache = map[textKey]*textMask{}
)

type textKey struct {
	f font.Face
	s string
}

func maskOf(f font.Face, s string) *textMask {
	k := textKey{f, s}
	textMu.Lock()
	defer textMu.Unlock()
	if m, ok := textCache[k]; ok {
		return m
	}
	b, _ := font.BoundString(f, s)
	bw, bh := (b.Max.X-b.Min.X).Ceil()+2, (b.Max.Y-b.Min.Y).Ceil()+2
	if bw <= 0 || bh <= 0 {
		return nil
	}
	mask := image.NewAlpha(image.Rect(0, 0, bw, bh))
	d := font.Drawer{Dst: mask, Src: image.Opaque, Face: f, Dot: fixed.Point26_6{X: -b.Min.X + 64, Y: -b.Min.Y + 64}}
	d.DrawString(s)
	if len(textCache) >= 256 { // a long fight goes through many numbers: start over now and then
		textCache = map[textKey]*textMask{}
	}
	m := &textMask{px: mask.Pix, w: bw, h: bh, dx: b.Min.X.Floor() - 1, dy: b.Min.Y.Floor() - 1}
	textCache[k] = m
	return m
}

// text at baseline y; a soft dark shadow under it keeps it readable over bright scenes
func (c *canvas) text(f font.Face, s string, x, y float64, col rgbf, a float64) {
	if f == nil || s == "" {
		return
	}
	m := maskOf(f, s)
	if m == nil {
		return
	}
	ox := int(math.Round(x)) + m.dx
	oy := int(math.Round(y)) + m.dy
	for pass := 0; pass < 2; pass++ {
		for j := 0; j < m.h; j++ {
			row := m.px[j*m.w : (j+1)*m.w]
			for i, v := range row {
				if v == 0 {
					continue
				}
				cv := float64(v) / 255
				if pass == 0 {
					c.blend(ox+i+1, oy+j+1, rgbf{0, 0, 0}, cv*a*0.55)
				} else {
					c.blend(ox+i, oy+j, col, cv*a)
				}
			}
		}
	}
}

func thousands(v float64) string {
	n := int64(math.Max(0, math.Round(v)))
	s := fmt.Sprint(n)
	var b strings.Builder
	for i, ch := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(ch)
	}
	return b.String()
}
func percent(f float64) string {
	p := int(math.Floor(f*100 + 1e-9))
	if p == 0 && f > 0 {
		p = 1
	}
	return fmt.Sprintf("%d%%", p)
}

// ------------------------------------------------------------------ the card

var (
	ovInk   = rgbf{0.94, 0.97, 0.98}
	ovAsh   = rgbf{0.62, 0.71, 0.75}
	ovGlass = rgbf{0.027, 0.043, 0.063}
	ovCoral = rgbf{1, 0.55, 0.61}
	ovPartC = rgbf{0.91, 0.93, 0.95}
	ovStag  = rgbf{1, 0.76, 0.4}
)

// the element colours (Dauntless's own: blaze orange, frost ice blue, shock yellow, terra green, radiant pale gold,
// umbral violet, neutral grey)
func elementColor(e string) rgbf {
	switch e {
	case "Blaze":
		return rgbf{1, 0.48, 0.24}
	case "Frost":
		return rgbf{0.5, 0.85, 1}
	case "Shock":
		return rgbf{1, 0.89, 0.35}
	case "Terra":
		return rgbf{0.61, 0.89, 0.42}
	case "Radiant":
		return rgbf{1, 0.95, 0.66}
	case "Umbral":
		return rgbf{0.71, 0.55, 1}
	}
	return rgbf{0.73, 0.78, 0.8}
}

// ovLayout: the card's size at a scale (so the window can be sized before drawing)
func ovLayout(m *ovModel, st ovStyle, u float64) (cardW, cardH, margin float64) {
	cardW, margin = math.Round(340*u), math.Round(16*u)
	y := 12*u + 18*u + 7*u + 10*u
	if m.element != "" || m.lock != "" {
		y += 15 * u
	}
	if st.Numbers {
		y += 18 * u
	}
	if m.hasStag {
		y += 21 * u
	}
	if n := len(m.parts); st.Parts && n > 0 {
		rows := (n + 1) / 2
		y += 11*u + 8*u + float64(rows)*21*u - 4*u
	}
	cardH = math.Round(y + 12*u)
	return
}

// ovRenderer keeps what does not change from frame to frame: the card's background (shadow, glass, hairline, glint)
// for its size and colours, and the two images it draws into, so an animation frame allocates nothing.
type ovRenderer struct {
	bgKey     string
	bg        []uint8
	card, out *image.RGBA
}

var ovDefault = &ovRenderer{}

// ovDraw renders the model at scale u (card plus a margin for its shadow). The image is reused by the next call.
func ovDraw(m *ovModel, st ovStyle, u float64) *image.RGBA { return ovDefault.draw(m, st, u) }

func reuse(img *image.RGBA, w, h int) *image.RGBA {
	if img == nil || img.Bounds().Dx() != w || img.Bounds().Dy() != h {
		return image.NewRGBA(image.Rect(0, 0, w, h))
	}
	return img
}

func (r *ovRenderer) draw(m *ovModel, st ovStyle, u float64) *image.RGBA {
	cw, ch, mg := ovLayout(m, st, u)
	W, H := int(cw+2*mg), int(ch+2*mg+8*u)
	r.out = reuse(r.out, W, H)
	clear(r.out.Pix)
	if m.alpha <= 0 {
		return r.out
	}
	ease := m.alpha * m.alpha * (3 - 2*m.alpha)
	acc := hexColor(st.Accent, rgbf{0.24, 0.92, 1})
	light := hexColor(st.Light, mix(acc, rgbf{1, 1, 1}, 0.25))
	deep := hexColor(st.Deep, mix(acc, rgbf{0, 0, 0}, 0.6))
	op := st.Opacity
	if op <= 0 {
		op = 0.85
	}
	// the card is drawn whole, in place, then faded and slid in as one piece
	x0, y0 := mg, mg+8*u
	key := fmt.Sprintf("%d %d %.3f %s %s %s %.3f", W, H, u, st.Accent, st.Light, st.Deep, op)
	if key != r.bgKey {
		r.card = reuse(r.card, W, H)
		clear(r.card.Pix)
		c := &canvas{img: r.card, w: W, h: H, fa: 1}
		for i := 4; i >= 1; i-- {
			g := float64(i) * 3 * u
			c.rrect(x0-g, y0-g+3*u, cw+2*g, ch+2*g, 10*u+g, flat(rgbf{0, 0, 0}), 0.07*op, nil)
		}
		c.rrect(x0, y0, cw, ch, 10*u, flat(ovGlass), op, nil)
		c.rrect(x0, y0, cw, ch*0.55, 10*u, flat(deep), 0.10*op, nil)
		c.ring(x0, y0, cw, ch, 10*u, acc, 0.30)
		c.rrect(x0+14*u, y0, cw-28*u, 1.2*u, 0.6*u, flat(light), 0.85, func(t float64) float64 { return math.Sin(t * math.Pi) })
		r.bg = append(r.bg[:0], r.card.Pix...)
		r.bgKey = key
	}
	r.card = reuse(r.card, W, H)
	copy(r.card.Pix, r.bg)
	c := &canvas{img: r.card, w: W, h: H, fa: 1}
	defer r.compose(ease, int(math.Round((1-ease)*-8*u)))

	pad := 12 * u
	ix, iw := x0+pad, cw-2*pad
	y := y0 + pad

	// name and percentage
	fName, fPct := ovFace(false, 15*u), ovFace(true, 15*u)
	pct := percent(m.disp)
	pctCol, pctA := light, 1.0
	if m.dead || m.target <= 0 {
		pct, pctCol, pctA = "Defeated", ovAsh, 0.9
	}
	pw := textWidth(fPct, pct)
	c.text(fName, fit(fName, m.name, iw-pw-12*u), ix, y+13*u, ovInk, 1)
	c.text(fPct, pct, ix+iw-pw, y+13*u, pctCol, pctA)
	y += 18*u + 7*u

	// element and weakness: a dot and the word in the element's colour ("Terra  ·  weak to Shock")
	if m.lock != "" {
		// lock-on: a small target and the part, right-aligned on the element line ("LOCKED  Head")
		fe, fb := ovFace(false, 11*u), ovFace(true, 11*u)
		part := fit(fb, m.lock, iw*0.4)
		w := 12*u + textWidth(fe, "LOCKED  ") + textWidth(fb, part)
		x := ix + iw - w
		c.ring(x, y, 8*u, 8*u, 4*u, acc, 0.95)
		c.rrect(x+2.75*u, y+2.75*u, 2.5*u, 2.5*u, 1.25*u, flat(acc), 1, nil)
		c.text(fe, "LOCKED  ", x+12*u, y+8*u, ovAsh, 0.85)
		c.text(fb, part, x+12*u+textWidth(fe, "LOCKED  "), y+8*u, light, 1)
	}
	if m.element != "" {
		fe := ovFace(false, 11*u)
		ec := elementColor(m.element)
		c.rrect(ix, y+1*u, 7*u, 7*u, 3.5*u, flat(ec), 0.95, nil)
		x := ix + 11*u
		c.text(fe, m.element, x, y+8*u, ec, 0.95)
		x += textWidth(fe, m.element)
		if m.weak != "" {
			mid := "  ·  weak to "
			c.text(fe, mid, x, y+8*u, ovAsh, 0.8)
			x += textWidth(fe, mid)
			c.text(fe, m.weak, x, y+8*u, elementColor(m.weak), 0.95)
		}
	}
	if m.element != "" || m.lock != "" {
		y += 15 * u
	}

	// overall health: thick bar in the preset's colours, a pale trail where the last hits landed
	bh := 10 * u
	c.rrect(ix, y, iw, bh, bh/2, flat(mix(deep, rgbf{0, 0, 0}, 0.45)), 0.9, nil)
	if m.ghost > m.disp {
		c.rrect(ix, y, iw*m.ghost, bh, bh/2, flat(light), 0.45, nil)
	}
	if fw := iw * m.disp; fw > 0.5 {
		c.rrect(ix-2*u, y-2*u, fw+4*u, bh+4*u, bh/2+2*u, flat(acc), 0.16, nil)
		c.rrect(ix, y, fw, bh, bh/2, func(t float64) rgbf { return mix(acc, light, t*t) }, 1, nil)
		c.rrect(ix, y, fw, bh*0.45, bh/2, flat(rgbf{1, 1, 1}), 0.16, nil)
		if m.flash > 0.01 {
			c.rrect(ix, y, fw, bh, bh/2, flat(rgbf{1, 1, 1}), 0.4*m.flash, nil)
		}
	}
	y += bh

	if st.Numbers {
		f := ovFace(false, 11*u)
		y += 5 * u
		c.text(f, thousands(m.cur)+" / "+thousands(m.max), ix, y+10*u, ovAsh, 1)
		c.text(f, "HEALTH", ix+iw-textWidth(f, "HEALTH"), y+10*u, ovAsh, 0.55)
		y += 13 * u
	}

	// stagger: how close it is to being staggered, a thin amber bar of its own under the health
	if m.hasStag {
		f, fv := ovFace(false, 10.5*u), ovFace(true, 10.5*u)
		y += 6 * u
		c.text(f, "STAGGER", ix, y+8*u, ovAsh, 0.7)
		v := percent(m.sDisp)
		c.text(fv, v, ix+iw-textWidth(fv, v), y+8*u, ovStag, 0.95)
		by, hb := y+11*u, 4*u
		c.rrect(ix, by, iw, hb, hb/2, flat(rgbf{1, 1, 1}), 0.10, nil)
		if fw := iw * m.sDisp; fw > 0.5 {
			c.rrect(ix, by, fw, hb, hb/2, flat(ovStag), 0.9, nil)
			if m.sDisp > m.sGhost {
				c.rrect(ix+iw*m.sGhost, by, iw*(m.sDisp-m.sGhost), hb, hb/2, flat(rgbf{1, 0.95, 0.85}), 0.7, nil)
			}
			if m.sFlash > 0.01 {
				c.rrect(ix, by, fw, hb, hb/2, flat(rgbf{1, 1, 1}), 0.4*m.sFlash, nil)
			}
		}
		y += 15 * u
	}

	// parts: two columns of thin neutral bars
	if n := len(m.parts); st.Parts && n > 0 {
		y += 11 * u
		c.rrect(ix, y-5*u, iw, 1, 0.5, flat(rgbf{1, 1, 1}), 0.08, nil)
		y += 3 * u
		f, fv := ovFace(false, 11*u), ovFace(true, 10.5*u)
		gap := 14 * u
		colW := (iw - gap) / 2
		for i, p := range m.parts {
			px := ix + float64(i%2)*(colW+gap)
			py := y + float64(i/2)*21*u
			pa := math.Min(1, math.Max(0, (m.now-p.born)/0.3)) // a part found mid-fight fades in
			broken := (p.target <= 0 && p.max > 0) || (p.brokeAt > 0 && m.now-p.brokeAt < 2.5)
			val, valCol, valA, nameA := percent(p.disp), ovAsh, 0.9, 0.86*pa
			if broken {
				val, valCol, valA, nameA = "Broken", ovCoral, 0.95, 0.5*pa
			}
			vw := textWidth(fv, val)
			// broken before and grown back: a small coral count after the name ("x1")
			tag := ""
			if p.breaks > 0 && !broken {
				tag = fmt.Sprintf("×%d", p.breaks)
			}
			tw := 0.0
			if tag != "" {
				tw = textWidth(fv, tag) + 5*u
			}
			name := fit(f, p.name, colW-vw-6*u-tw)
			if m.lock != "" && strings.EqualFold(p.name, m.lock) { // the part the lock-on holds
				c.ring(px-4*u, py-2*u, colW+8*u, 19*u, 5*u, acc, 0.6)
			}
			c.text(f, name, px, py+9*u, ovInk, nameA)
			if tag != "" {
				c.text(fv, tag, px+textWidth(f, name)+5*u, py+9*u, ovCoral, 0.85*pa)
			}
			c.text(fv, val, px+colW-vw, py+9*u, valCol, valA)
			by, hb := py+12*u, 4*u
			c.rrect(px, by, colW, hb, hb/2, flat(rgbf{1, 1, 1}), 0.10, nil)
			if p.ghost > p.disp {
				c.rrect(px, by, colW*p.ghost, hb, hb/2, flat(ovPartC), 0.32, nil)
			}
			if fw := colW * p.disp; fw > 0.5 {
				c.rrect(px, by, fw, hb, hb/2, flat(ovPartC), 0.9, nil)
				if p.flash > 0.01 {
					c.rrect(px, by, fw, hb, hb/2, flat(light), 0.6*p.flash, nil)
				}
			}
		}
	}
	return r.out
}

// compose puts the card into the output, faded by ease and moved dy pixels (premultiplied: every channel scales)
func (r *ovRenderer) compose(ease float64, dy int) {
	W, H := r.out.Bounds().Dx(), r.out.Bounds().Dy()
	k := uint32(ease*256 + 0.5)
	if k > 256 {
		k = 256
	}
	for y := 0; y < H; y++ {
		sy := y - dy
		if sy < 0 || sy >= H {
			continue
		}
		src := r.card.Pix[sy*r.card.Stride : sy*r.card.Stride+W*4]
		dst := r.out.Pix[y*r.out.Stride : y*r.out.Stride+W*4]
		if k == 256 {
			copy(dst, src)
			continue
		}
		for i, v := range src {
			dst[i] = uint8(uint32(v) * k >> 8)
		}
	}
}

// ovPlace: where the card's window goes inside the game's client area (gw x gh), for the chosen position
func ovPlace(pos string, gw, gh, ww, wh, mg float64) (x, y float64) {
	switch pos {
	case "top-left":
		return gw*0.015 - mg, gh*0.03 - mg
	case "top-right":
		return gw - ww - gw*0.015 + mg, gh*0.03 - mg
	case "right":
		return gw - ww - gw*0.015 + mg, gh*0.36 - mg
	default: // top centre, just under where the compass sits
		return (gw - ww) / 2, gh*0.075 - mg
	}
}
