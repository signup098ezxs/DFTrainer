//go:build windows

package main

// The behemoth overlay on screen: "Lantern Client.exe --overlay <panel address> <token>", started by the panel while
// the game runs and the overlay is on. A click-through, always-on-top layered window that never takes focus, sitting
// over the game's window and shown only while the game is the window in front (as Dauntless Forever's Boss Health
// Bar does). It asks the panel for the behemoth ten times a second and draws with overlay_draw.go: only while
// something moves (up to 60 frames a second), otherwise it just waits. It quits by itself when the game closes, the
// overlay is turned off or the panel stops answering.

import (
	"encoding/json"
	"net/http"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

var (
	gdi32                       = syscall.NewLazyDLL("gdi32.dll")
	ovCreateCompatibleDC        = gdi32.NewProc("CreateCompatibleDC")
	ovCreateDIBSection          = gdi32.NewProc("CreateDIBSection")
	ovSelectObject              = gdi32.NewProc("SelectObject")
	ovDeleteObject              = gdi32.NewProc("DeleteObject")
	ovRegisterClassExW          = user32.NewProc("RegisterClassExW")
	ovCreateWindowExW           = user32.NewProc("CreateWindowExW")
	ovDefWindowProcW            = user32.NewProc("DefWindowProcW")
	ovPeekMessageW              = user32.NewProc("PeekMessageW")
	ovTranslateMessage          = user32.NewProc("TranslateMessage")
	ovDispatchMessageW          = user32.NewProc("DispatchMessageW")
	ovUpdateLayeredWindow       = user32.NewProc("UpdateLayeredWindow")
	ovEnumWindows               = user32.NewProc("EnumWindows")
	ovGetClassNameW             = user32.NewProc("GetClassNameW")
	ovGetWindowThreadProcessId  = user32.NewProc("GetWindowThreadProcessId")
	ovGetForegroundWindow       = user32.NewProc("GetForegroundWindow")
	ovGetClientRect             = user32.NewProc("GetClientRect")
	ovClientToScreen            = user32.NewProc("ClientToScreen")
	ovIsWindow                  = user32.NewProc("IsWindow")
	ovSetDpiAwarenessContext    = user32.NewProc("SetProcessDpiAwarenessContext")
	ovSetProcessDPIAware        = user32.NewProc("SetProcessDPIAware")
	ovCreateMutexW              = kernel32.NewProc("CreateMutexW")
	ovGetModuleHandleW          = kernel32.NewProc("GetModuleHandleW")
	ovOpenProcess               = kernel32.NewProc("OpenProcess")
	ovQueryFullProcessImageName = kernel32.NewProc("QueryFullProcessImageNameW")
	ovCloseHandle               = kernel32.NewProc("CloseHandle")
)

type ovWndClassEx struct {
	cbSize, style                    uint32
	lpfnWndProc                      uintptr
	cbClsExtra, cbWndExtra           int32
	hInstance, hIcon, hCursor, hbrBg uintptr
	lpszMenuName, lpszClassName      *uint16
	hIconSm                          uintptr
}
type ovMsg struct {
	hwnd    uintptr
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pt      struct{ x, y int32 }
	private uint32
}
type ovRect struct{ left, top, right, bottom int32 }
type ovPoint struct{ x, y int32 }
type ovSize struct{ cx, cy int32 }
type ovBitmapInfoHeader struct {
	biSize                         uint32
	biWidth, biHeight              int32
	biPlanes, biBitCount           uint16
	biCompression, biSizeImage     uint32
	biXPelsPerMeter, biYPelsPerMet int32
	biClrUsed, biClrImportant      uint32
}

// ------------------------------------------------------------------ what the panel says

type ovReply struct {
	OK      bool    `json:"ok"`
	On      bool    `json:"on"`
	Running bool    `json:"running"`
	Style   ovStyle `json:"style"`
	B       *ovBeh  `json:"b"`
}

type ovFeed struct {
	mu     sync.Mutex
	last   ovReply
	seq    int
	okAt   time.Time
	failed int
}

func (f *ovFeed) poll(base, token string) {
	cl := &http.Client{Timeout: 1500 * time.Millisecond}
	req, err := http.NewRequest("GET", strings.TrimRight(base, "/")+"/api/overlay/state", nil)
	if err != nil {
		logf("overlay: bad panel address %q", base)
		return
	}
	req.Header.Set("X-Trainer-Token", token)
	for {
		var r ovReply
		resp, err := cl.Do(req)
		if err == nil {
			err = json.NewDecoder(resp.Body).Decode(&r)
			resp.Body.Close()
		}
		f.mu.Lock()
		if err == nil && r.OK {
			f.last, f.okAt, f.failed = r, time.Now(), 0
			f.seq++
		} else {
			f.failed++
		}
		f.mu.Unlock()
		time.Sleep(100 * time.Millisecond)
	}
}

// ------------------------------------------------------------------ the game's window

var ovGameWnd uintptr

func ovExeOf(hwnd uintptr) string {
	var pid uint32
	ovGetWindowThreadProcessId.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	h, _, _ := ovOpenProcess.Call(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, 0, uintptr(pid))
	if h == 0 {
		return ""
	}
	defer ovCloseHandle.Call(h)
	buf := make([]uint16, 520)
	n := uint32(len(buf))
	if r, _, _ := ovQueryFullProcessImageName.Call(h, 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&n))); r == 0 {
		return ""
	}
	return syscall.UTF16ToString(buf[:n])
}

var ovEnumCb = syscall.NewCallback(func(hwnd, _ uintptr) uintptr {
	if v, _, _ := procIsWindowVisible.Call(hwnd); v == 0 {
		return 1
	}
	cls := make([]uint16, 64)
	ovGetClassNameW.Call(hwnd, uintptr(unsafe.Pointer(&cls[0])), 64)
	if syscall.UTF16ToString(cls) != "UnrealWindow" {
		return 1
	}
	// your game only: the hidden server copies run the same exe but never show a window
	if strings.HasSuffix(strings.ToLower(ovExeOf(hwnd)), `\dauntless-win64-shipping.exe`) {
		ovGameWnd = hwnd
		return 0
	}
	return 1
})

func ovFindGame() uintptr {
	if ovGameWnd != 0 {
		if ok, _, _ := ovIsWindow.Call(ovGameWnd); ok != 0 {
			if v, _, _ := procIsWindowVisible.Call(ovGameWnd); v != 0 {
				return ovGameWnd
			}
		}
	}
	ovGameWnd = 0
	ovEnumWindows.Call(ovEnumCb, 0)
	return ovGameWnd
}

// ------------------------------------------------------------------ the window

type ovWindow struct {
	hwnd, dc, bmp uintptr
	bits          unsafe.Pointer
	w, h          int
	shown         bool
}

var ovWndProc = syscall.NewCallback(func(hwnd, msg, wp, lp uintptr) uintptr {
	r, _, _ := ovDefWindowProcW.Call(hwnd, msg, wp, lp)
	return r
})

func ovCreate() *ovWindow {
	cls, _ := syscall.UTF16PtrFromString("LanternOverlay")
	inst, _, _ := ovGetModuleHandleW.Call(0)
	wc := ovWndClassEx{lpfnWndProc: ovWndProc, lpszClassName: cls, hInstance: inst}
	wc.cbSize = uint32(unsafe.Sizeof(wc))
	ovRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))
	const exStyle = 0x00080000 | 0x00000020 | 0x00000008 | 0x00000080 | 0x08000000 // LAYERED|TRANSPARENT|TOPMOST|TOOLWINDOW|NOACTIVATE
	title, _ := syscall.UTF16PtrFromString("Lantern Client overlay")
	h, _, _ := ovCreateWindowExW.Call(exStyle, uintptr(unsafe.Pointer(cls)), uintptr(unsafe.Pointer(title)), 0x80000000 /* WS_POPUP */, 0, 0, 1, 1, 0, 0, inst, 0)
	if h == 0 {
		return nil
	}
	dc, _, _ := ovCreateCompatibleDC.Call(0)
	return &ovWindow{hwnd: h, dc: dc}
}

// put draws img (premultiplied RGBA) at screen position x, y
func (o *ovWindow) put(img []uint8, w, h int, x, y int32) {
	if w != o.w || h != o.h || o.bmp == 0 {
		bi := ovBitmapInfoHeader{biWidth: int32(w), biHeight: -int32(h), biPlanes: 1, biBitCount: 32}
		bi.biSize = uint32(unsafe.Sizeof(bi))
		var bits unsafe.Pointer
		nb, _, _ := ovCreateDIBSection.Call(o.dc, uintptr(unsafe.Pointer(&bi)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
		if nb == 0 {
			return
		}
		ovSelectObject.Call(o.dc, nb) // the old bitmap leaves the DC first: a selected bitmap cannot be deleted
		if o.bmp != 0 {
			ovDeleteObject.Call(o.bmp)
		}
		o.bmp, o.bits, o.w, o.h = nb, bits, w, h
	}
	dst := unsafe.Slice((*uint8)(o.bits), w*h*4)
	for i := 0; i+3 < len(img) && i+3 < len(dst); i += 4 { // RGBA -> BGRA
		dst[i], dst[i+1], dst[i+2], dst[i+3] = img[i+2], img[i+1], img[i], img[i+3]
	}
	pos, size, src := ovPoint{x, y}, ovSize{int32(w), int32(h)}, ovPoint{}
	blend := uint32(0x01FF0000) // AC_SRC_OVER, 0, 255, AC_SRC_ALPHA
	ovUpdateLayeredWindow.Call(o.hwnd, 0, uintptr(unsafe.Pointer(&pos)), uintptr(unsafe.Pointer(&size)), o.dc,
		uintptr(unsafe.Pointer(&src)), 0, uintptr(unsafe.Pointer(&blend)), 2 /* ULW_ALPHA */)
	if !o.shown {
		procShowWindow.Call(o.hwnd, 4 /* SW_SHOWNOACTIVATE */)
		procShowWindow.Call(o.hwnd, 4) // the first call of a process can be overridden by how it was started
		procSetWindowPos.Call(o.hwnd, ^uintptr(0) /* HWND_TOPMOST */, 0, 0, 0, 0, 0x0001|0x0002|0x0010)
		o.shown = true
	}
}

func (o *ovWindow) hide() {
	if o.shown {
		procShowWindow.Call(o.hwnd, 0)
		o.shown = false
	}
}

// ------------------------------------------------------------------ main loop

func runOverlay(base, token string) {
	name, _ := syscall.UTF16PtrFromString(`Local\LanternClientOverlay`)
	if h, _, err := ovCreateMutexW.Call(0, 0, uintptr(unsafe.Pointer(name))); h == 0 || err == syscall.Errno(183) {
		return // one overlay at a time
	}
	runtime.LockOSThread()
	// real pixels, like the game's own window (Windows 10 1703 and later; older ones get the basic version)
	if ovSetDpiAwarenessContext.Find() == nil {
		ovSetDpiAwarenessContext.Call(^uintptr(3) /* PER_MONITOR_AWARE_V2 (-4) */)
	} else if ovSetProcessDPIAware.Find() == nil {
		ovSetProcessDPIAware.Call()
	}
	logf("overlay started")
	feed := &ovFeed{okAt: time.Now()}
	go feed.poll(base, token)
	win := ovCreate()
	if win == nil {
		logf("overlay: window could not be created")
		return
	}
	model := &ovModel{}
	start := time.Now()
	last, lastSeq, lastFind := start, -1, time.Time{}
	var game uintptr
	gameSeen, gameGoneAt := false, time.Time{}
	var lastKey string
	var lastPos [4]int32
	for {
		var m ovMsg
		for {
			r, _, _ := ovPeekMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0, 1 /* PM_REMOVE */)
			if r == 0 {
				break
			}
			ovTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
			ovDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
		}
		now := time.Now()
		t := now.Sub(start).Seconds()
		dt := now.Sub(last).Seconds()
		last = now

		feed.mu.Lock()
		rep, seq, okAt := feed.last, feed.seq, feed.okAt
		feed.mu.Unlock()
		if now.Sub(okAt) > 15*time.Second {
			logf("overlay: the panel stopped answering, closing")
			return
		}
		if seq > 0 && !rep.On {
			logf("overlay: turned off, closing")
			return
		}
		if now.Sub(lastFind) > time.Second {
			lastFind = now
			game = ovFindGame()
			if game != 0 && !gameSeen {
				gameSeen = true
				logf("overlay: found the game window")
			}
			if game == 0 {
				if gameGoneAt.IsZero() {
					gameGoneAt = now
				}
				if (gameSeen && now.Sub(gameGoneAt) > 20*time.Second) || (!gameSeen && now.Sub(start) > 90*time.Second) {
					logf("overlay: the game is closed, closing")
					return
				}
			} else {
				gameGoneAt = time.Time{}
			}
		}

		fresh := seq != lastSeq
		if fresh {
			lastSeq = seq
			b := rep.B
			if b != nil && b.Max <= 0 {
				b = nil
			}
			model.update(b, t)
		}
		moving := model.step(t, dt)

		fg, _, _ := ovGetForegroundWindow.Call()
		iconic := uintptr(1)
		if game != 0 {
			iconic, _, _ = procIsIconic.Call(game)
		}
		if game == 0 || fg != game || iconic != 0 || model.alpha <= 0 {
			win.hide()
			lastKey = ""
			time.Sleep(60 * time.Millisecond)
			continue
		}
		var rc ovRect
		var tl ovPoint
		ovGetClientRect.Call(game, uintptr(unsafe.Pointer(&rc)))
		ovClientToScreen.Call(game, uintptr(unsafe.Pointer(&tl)))
		gw, gh := float64(rc.right-rc.left), float64(rc.bottom-rc.top)
		if gw < 300 || gh < 200 {
			win.hide()
			time.Sleep(60 * time.Millisecond)
			continue
		}
		st := rep.Style
		if st.Scale <= 0 {
			st.Scale = 1
		}
		u := gh / 1080 * st.Scale
		if u < 0.6 {
			u = 0.6
		} else if u > 3 {
			u = 3
		}
		key := model.key
		pos := [4]int32{tl.x, tl.y, int32(gw), int32(gh)}
		if moving || fresh || !win.shown || key != lastKey || pos != lastPos {
			img := ovDraw(model, st, u)
			_, _, mg := ovLayout(model, st, u)
			w, h := img.Bounds().Dx(), img.Bounds().Dy()
			x, y := ovPlace(st.Pos, gw, gh, float64(w), float64(h), mg)
			win.put(img.Pix, w, h, tl.x+int32(x), tl.y+int32(y))
			lastKey, lastPos = key, pos
		}
		if moving {
			time.Sleep(16 * time.Millisecond)
		} else {
			time.Sleep(50 * time.Millisecond)
		}
	}
}
