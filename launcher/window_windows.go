//go:build windows

package main

// DF Trainer's own window: a native Win32 window with the panel drawn inside by WebView2, the web engine built into
// Windows 10 and 11. No browser opens. The window has DF Trainer's icon and title, a dark title bar, and a size
// that fits the screen at any display scaling.

import (
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"

	webview2 "dftrainer/launcher/internal/third_party/webview2"
)

// the window's message loop must stay on the thread that created the window
func init() { runtime.LockOSThread() }

const windowTitle = "DF Trainer"

var (
	dwmapi                    = syscall.NewLazyDLL("dwmapi.dll")
	procDwmSetWindowAttribute = dwmapi.NewProc("DwmSetWindowAttribute")
	procGetDpiForSystem       = user32.NewProc("GetDpiForSystem")
	procSystemParametersInfoW = user32.NewProc("SystemParametersInfoW")
	procSetWindowPos          = user32.NewProc("SetWindowPos")
	procFindWindowW           = user32.NewProc("FindWindowW")
	procShowWindow            = user32.NewProc("ShowWindow")
	procIsIconic              = user32.NewProc("IsIconic")
	procSetForegroundWindow   = user32.NewProc("SetForegroundWindow")
)

type rect struct{ L, T, R, B int32 }

func dpiScale() float64 {
	if procGetDpiForSystem.Find() == nil {
		if d, _, _ := procGetDpiForSystem.Call(); d > 0 {
			return float64(d) / 96
		}
	}
	return 1
}

func workArea() rect {
	var r rect
	procSystemParametersInfoW.Call(0x30 /* SPI_GETWORKAREA */, 0, uintptr(unsafe.Pointer(&r)), 0)
	if r.R <= r.L || r.B <= r.T {
		r = rect{0, 0, 1280, 800}
	}
	return r
}

// preferredSize: the size picked in Settings (in screen points), else one that fits the screen
func preferredSize() (int, int) {
	if p := strings.Split(windowSize(), ","); len(p) == 2 {
		w, e1 := strconv.Atoi(p[0])
		h, e2 := strconv.Atoi(p[1])
		if e1 == nil && e2 == nil {
			return w, h
		}
	}
	s, wa := dpiScale(), workArea()
	w := int(float64(wa.R-wa.L) / s * 0.82)
	h := int(float64(wa.B-wa.T) / s * 0.86)
	return clamp(w, 900, 1280), clamp(h, 600, 820)
}
func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// placement turns a size in points into pixels at the current scaling, kept inside the work area and centred on it
func placement(wPt, hPt int) (x, y, w, h int) {
	s, wa := dpiScale(), workArea()
	maxW, maxH := int(wa.R-wa.L), int(wa.B-wa.T)
	w, h = int(float64(wPt)*s), int(float64(hPt)*s)
	if w > maxW {
		w = maxW
	}
	if h > maxH {
		h = maxH
	}
	return int(wa.L) + (maxW-w)/2, int(wa.T) + (maxH-h)/2, w, h
}

func moveWindow(hwnd uintptr, wPt, hPt int) {
	x, y, w, h := placement(wPt, hPt)
	procSetWindowPos.Call(hwnd, 0, uintptr(x), uintptr(y), uintptr(w), uintptr(h), 0x0004|0x0020 /* NOZORDER|FRAMECHANGED */)
}

// focusExisting brings an open DF Trainer window to the front. True if there was one.
func focusExisting() bool {
	cls, _ := syscall.UTF16PtrFromString("webview")
	title, _ := syscall.UTF16PtrFromString(windowTitle)
	hwnd, _, _ := procFindWindowW.Call(uintptr(unsafe.Pointer(cls)), uintptr(unsafe.Pointer(title)))
	if hwnd == 0 {
		return false
	}
	if iconic, _, _ := procIsIconic.Call(hwnd); iconic != 0 {
		procShowWindow.Call(hwnd, 9 /* SW_RESTORE */)
	}
	procSetForegroundWindow.Call(hwnd)
	return true
}

// waitWindowClosed: after "Restart to update", the old window closes itself; wait for that (a few seconds at most)
func waitWindowClosed() {
	cls, _ := syscall.UTF16PtrFromString("webview")
	title, _ := syscall.UTF16PtrFromString(windowTitle)
	for i := 0; i < 40; i++ {
		if h, _, _ := procFindWindowW.Call(uintptr(unsafe.Pointer(cls)), uintptr(unsafe.Pointer(title))); h == 0 {
			return
		}
		time.Sleep(150 * time.Millisecond)
	}
}

// openAppWindow shows the panel at url in DF Trainer's own window and returns when the window is closed.
func openAppWindow(url string) {
	if focusExisting() {
		return
	}
	// before WebView2 starts: a dark first frame (no white flash), and sounds allowed from the start (the intro)
	os.Setenv("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "FF060A0F")
	os.Setenv("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--autoplay-policy=no-user-gesture-required")

	wPt, hPt := preferredSize()
	_, _, w, h := placement(wPt, hPt)
	wv := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     false,
		AutoFocus: true,
		DataPath:  filepath.Join(rootDir(), "webview"),
		WindowOptions: webview2.WindowOptions{
			Title: windowTitle, Width: uint(w), Height: uint(h), IconId: 1, Center: true,
		},
	})
	if wv == nil {
		logf("WebView2 could not start")
		if confirm("DF Trainer", "DF Trainer needs the Microsoft WebView2 Runtime, which is part of Windows 11 and of an up-to-date Windows 10, but is missing here.\n\nOpen the download page now? Install it, then open DF Trainer again.") {
			_ = startDetached("rundll32.exe", []string{"url.dll,FileProtocolHandler", "https://go.microsoft.com/fwlink/p/?LinkId=2124703"})
		}
		return
	}
	defer wv.Destroy()
	hwnd := uintptr(wv.Window())
	dark := int32(1)
	if r, _, _ := procDwmSetWindowAttribute.Call(hwnd, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, uintptr(unsafe.Pointer(&dark)), 4); r != 0 {
		procDwmSetWindowAttribute.Call(hwnd, 19, uintptr(unsafe.Pointer(&dark)), 4) // older Windows 10 builds
	}
	moveWindow(hwnd, wPt, hPt)

	// called from the panel: Settings > Window size, and closing this window after "Restart to update"
	_ = wv.Bind("dftResize", func(wPt, hPt int) error {
		wv.Dispatch(func() { moveWindow(hwnd, clamp(wPt, 600, 4000), clamp(hPt, 500, 4000)) })
		return nil
	})
	_ = wv.Bind("dftClose", func() { wv.Dispatch(wv.Terminate) })

	wv.Navigate(url)
	logf("window open")
	wv.Run()
	logf("window closed")
}
