package main

// The quest tracker card: the quests you are on, each objective's progress as the game reports it ("1/3"), in the
// same glass card and colour preset as the behemoth overlay, drawn into its own small window. A quest that arrives
// fades and opens in; one that is finished or gone closes and fades out; progress bars glide to the new amount and a
// finished objective gets a check. Nothing here is made up: a value the game did not give (nil) is not shown.

import (
	"fmt"
	"image"
	"math"
	"strconv"
)

// ------------------------------------------------------------------ data from the panel

type ovQObj struct {
	D    string   `json:"d"`
	C    *float64 `json:"c"`
	R    *float64 `json:"r"`
	Done bool     `json:"done"`
}
type ovQuest struct {
	Key      string   `json:"key"`
	Title    string   `json:"title"`
	Cat      string   `json:"cat"`
	Complete bool     `json:"complete"`
	Obj      []ovQObj `json:"obj"`
	More     int      `json:"more"`
}

// ------------------------------------------------------------------ animation model

type qObjAnim struct {
	d              string
	cur, req       float64
	hasCur, hasReq bool
	done           bool
	target, disp   float64
	flash, doneAt  float64
}
type qAnim struct {
	key, title, cat string
	complete        bool
	completeAt      float64
	obj             []*qObjAnim
	more            int
	vis, visTarget  float64 // opens in (0 -> 1) and closes out
}
type qModel struct {
	quests             []*qAnim
	alpha, alphaTarget float64
	now                float64
}

func (m *qModel) update(qs []ovQuest, now float64) {
	old := map[string]*qAnim{}
	for _, q := range m.quests {
		old[q.key] = q
	}
	seen := map[string]bool{}
	out := make([]*qAnim, 0, len(qs)+len(m.quests))
	for _, q := range qs {
		a := old[q.Key]
		if a == nil {
			a = &qAnim{key: q.Key}
			if m.alpha < 0.02 {
				a.vis = 1 // the card itself fades in: no second animation inside it
			}
		}
		if q.Complete && !a.complete {
			a.completeAt = now
		}
		a.title, a.cat, a.complete, a.more, a.visTarget = q.Title, q.Cat, q.Complete, q.More, 1
		// objectives are matched by their text and, for the same text, by its order (the 2nd "" is the 2nd ""): two
		// with one description never share one animation
		prev := map[string]*qObjAnim{}
		n := map[string]int{}
		for _, o := range a.obj {
			prev[dupKey(n, o.d)] = o
		}
		n = map[string]int{}
		objs := make([]*qObjAnim, 0, len(q.Obj))
		for _, o := range q.Obj {
			x := prev[dupKey(n, o.D)]
			if x == nil {
				x = &qObjAnim{d: o.D}
			}
			x.hasCur, x.hasReq = o.C != nil, o.R != nil && *o.R > 0
			if x.hasCur {
				if *o.C > x.cur && x.disp > 0 {
					x.flash = 1
				}
				x.cur = *o.C
			}
			if x.hasReq {
				x.req = *o.R
			}
			if o.Done && !x.done {
				x.doneAt = now
			}
			x.done = o.Done
			switch {
			case x.done:
				x.target = 1
			case x.hasCur && x.hasReq:
				x.target = math.Max(0, math.Min(1, x.cur/x.req))
			default:
				x.target = 0
			}
			objs = append(objs, x)
		}
		a.obj = objs
		seen[q.Key] = true
		out = append(out, a)
	}
	// gone from the list (finished and handed in, abandoned, or filtered out): it closes in place, then goes
	for _, q := range m.quests {
		if !seen[q.key] && q.vis > 0.01 {
			q.visTarget = 0
			out = append(out, q)
		}
	}
	m.quests = out
	if len(qs) > 0 {
		m.alphaTarget = 1
	} else {
		m.alphaTarget = 0
	}
}

func (m *qModel) step(now, dt float64) bool {
	m.now = now
	moving := false
	if m.alpha != m.alphaTarget {
		d := dt / 0.25
		if m.alphaTarget > m.alpha {
			m.alpha = math.Min(m.alphaTarget, m.alpha+d)
		} else {
			m.alpha = math.Max(m.alphaTarget, m.alpha-d)
		}
		moving = true
	}
	keep := m.quests[:0]
	for _, q := range m.quests {
		if q.vis != q.visTarget {
			q.vis = approach(q.vis, q.visTarget, dt, 0.12)
			if math.Abs(q.vis-q.visTarget) < 0.004 {
				q.vis = q.visTarget
			}
			moving = true
		}
		if q.visTarget == 0 && q.vis <= 0.004 {
			continue
		}
		if q.complete && now-q.completeAt < 1.2 {
			moving = true
		}
		for _, o := range q.obj {
			if math.Abs(o.disp-o.target) > 0.001 {
				o.disp = approach(o.disp, o.target, dt, 0.18)
				moving = true
			} else {
				o.disp = o.target
			}
			if o.flash > 0.01 {
				o.flash *= math.Exp(-dt / 0.25)
				moving = true
			} else {
				o.flash = 0
			}
		}
		keep = append(keep, q)
	}
	m.quests = keep
	return moving
}

// ------------------------------------------------------------------ drawing

func questColor(cat string, acc rgbf) rgbf {
	switch cat {
	case "main":
		return acc
	case "side":
		return rgbf{0.91, 0.93, 0.95}
	case "special":
		return rgbf{1, 0.85, 0.47}
	case "rumour":
		return rgbf{0.78, 0.65, 1}
	}
	return ovAsh
}

func ease3(t float64) float64 { return t * t * (3 - 2*t) }

const qObjH, qTitleH, qGap = 22.0, 18.0, 9.0

func qBlockH(q *qAnim) float64 {
	h := qTitleH
	if !q.complete {
		h += float64(len(q.obj)) * qObjH
		if q.more > 0 {
			h += 13
		}
	}
	return h
}

// qLayout: the card's size at scale u
func qLayout(m *qModel, u float64) (cardW, cardH, margin float64) {
	cardW, margin = math.Round(300*u), math.Round(16*u)
	y := 12*u + 12*u // padding and the "QUESTS" line
	for i, q := range m.quests {
		f := ease3(q.vis)
		if i > 0 {
			y += qGap * u * f
		}
		y += qBlockH(q) * u * f
	}
	cardH = math.Round(y + 10*u)
	return
}

var qDefault = &ovRenderer{}

func qDraw(m *qModel, st ovStyle, u float64) *image.RGBA { return qDefault.drawQuests(m, st, u) }

func (r *ovRenderer) drawQuests(m *qModel, st ovStyle, u float64) *image.RGBA {
	cw, ch, mg := qLayout(m, u)
	W, H := int(cw+2*mg), int(ch+2*mg+8*u)
	r.out = reuse(r.out, W, H)
	clear(r.out.Pix)
	if m.alpha <= 0 {
		return r.out
	}
	ease := ease3(m.alpha)
	acc := hexColor(st.Accent, rgbf{0.24, 0.92, 1})
	light := hexColor(st.Light, mix(acc, rgbf{1, 1, 1}, 0.25))
	deep := hexColor(st.Deep, mix(acc, rgbf{0, 0, 0}, 0.6))
	op := st.Opacity
	if op <= 0 {
		op = 0.85
	}
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
		c.rrect(x0, y0, cw, math.Min(ch, 40*u), 10*u, flat(deep), 0.10*op, nil)
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
	y := y0 + 10*u
	fh := ovFace(true, 9.5*u)
	c.text(fh, "QUESTS", ix, y+8*u, ovAsh, 0.7)
	y += 14 * u

	fTitle, fObj, fNum, fTag := ovFace(false, 13*u), ovFace(false, 11*u), ovFace(true, 11*u), ovFace(true, 9.5*u)
	for i, q := range m.quests {
		f := ease3(q.vis)
		if f <= 0.01 {
			continue
		}
		if i > 0 {
			gy := y + qGap*u*f/2
			c.rrect(ix, gy-0.5, iw, 1, 0.5, flat(rgbf{1, 1, 1}), 0.07*f, nil)
			y += qGap * u * f
		}
		// the block opens from the top: its rows appear as the space for them does
		bottom := y + qBlockH(q)*u*f
		row := func(h float64) (float64, float64) { // the row's alpha (0 while outside the opened space)
			a := math.Max(0, math.Min(1, (bottom-(y+h*u*0.6))/(h*u*0.6)))
			return a * f, h
		}
		// title: a dot in the quest kind's colour, the name, "COMPLETE" once it is done
		a, _ := row(qTitleH)
		qc := questColor(q.cat, acc)
		c.rrect(ix, y+5*u, 6*u, 6*u, 3*u, flat(qc), 0.95*a, nil)
		title := q.title
		if title == "" {
			title = map[string]string{"main": "Main quest", "side": "Side quest", "special": "Special quest", "rumour": "Rumour"}[q.cat]
			if title == "" {
				title = "Quest"
			}
		}
		tagW := 0.0
		if q.complete {
			tag := "COMPLETE"
			tagW = textWidth(fTag, tag) + 8*u
			pulse := 0.0
			if d := m.now - q.completeAt; d < 1.2 {
				pulse = 1 - d/1.2
			}
			c.text(fTag, tag, ix+iw-textWidth(fTag, tag), y+11*u, mix(rgbf{0.31, 0.94, 0.71}, rgbf{1, 1, 1}, pulse*0.6), a)
		}
		c.text(fTitle, fit(fTitle, title, iw-11*u-tagW), ix+11*u, y+12*u, ovInk, a)
		y += qTitleH * u * f
		if q.complete {
			continue
		}
		for _, o := range q.obj {
			a, _ := row(qObjH)
			num := ""
			switch {
			case o.hasCur && o.hasReq:
				num = fmt.Sprintf("%s/%s", thousands(o.cur), thousands(o.req))
			case o.done:
				num = "Done"
			case o.hasCur:
				num = thousands(o.cur)
			}
			nw := 0.0
			if num != "" {
				nw = textWidth(fNum, num) + 8*u
			}
			ox := ix + 11*u
			ow := iw - 11*u
			txt, txtA, numCol := o.d, 0.86, light
			if o.done {
				txtA, numCol = 0.5, rgbf{0.31, 0.94, 0.71}
				// a check before a finished objective
				ck := ix + 1*u
				c.rrect(ck, y+5*u, 6*u, 1.4*u, 0.7*u, flat(numCol), 0.9*a, nil)
				c.rrect(ck+2*u, y+3*u, 1.4*u, 4*u, 0.7*u, flat(numCol), 0.9*a, nil)
			}
			if txt == "" {
				txt = "Objective"
			}
			c.text(fObj, fit(fObj, txt, ow-nw), ox, y+10*u, ovInk, txtA*a)
			if num != "" {
				c.text(fNum, num, ix+iw-textWidth(fNum, num), y+10*u, mix(numCol, rgbf{1, 1, 1}, o.flash*0.7), a)
			}
			// progress: a thin bar (only when the game gives both amounts, or the objective is done)
			if (o.hasCur && o.hasReq) || o.done {
				by, hb := y+14*u, 2.5*u
				c.rrect(ox, by, ow, hb, hb/2, flat(rgbf{1, 1, 1}), 0.09*a, nil)
				if fw := ow * o.disp; fw > 0.5 {
					col := func(t float64) rgbf { return mix(acc, light, t) }
					if o.done {
						col = flat(rgbf{0.31, 0.94, 0.71})
					}
					c.rrect(ox, by, fw, hb, hb/2, col, 0.9*a, nil)
					if o.flash > 0.01 {
						c.rrect(ox, by, fw, hb, hb/2, flat(rgbf{1, 1, 1}), 0.5*o.flash*a, nil)
					}
				}
			}
			y += qObjH * u * f
		}
		if q.more > 0 {
			a, _ := row(13)
			c.text(fObj, fmt.Sprintf("+%d more", q.more), ix+11*u, y+9*u, ovAsh, 0.6*a)
			y += 13 * u * f
		}
	}
	return r.out
}

// dupKey: s, or s plus how many times it came before ("Leg", "Leg\x001"), counted in n
func dupKey(n map[string]int, s string) string {
	k := s
	if c := n[s]; c > 0 {
		k = s + "\x00" + strconv.Itoa(c)
	}
	n[s]++
	return k
}
