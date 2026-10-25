//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"dftrainer/launcher/internal/third_party/xsys/windows"
	"dftrainer/launcher/internal/third_party/xsys/windows/registry"
)

const (
	exeName       = "Lantern Client.exe"
	legacyExeName = "DF Trainer.exe" // the name before the rename: installs from then still run it (see migrateLegacy)
	nodeExeName   = "node.exe"

	createNoWindow        = 0x08000000
	createNewProcessGroup = 0x00000200
	stillActive           = 259
)

var (
	user32      = syscall.NewLazyDLL("user32.dll")
	messageBoxW = user32.NewProc("MessageBoxW")
)

func defaultRoot() string {
	la := os.Getenv("LOCALAPPDATA")
	if la == "" {
		la = filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Local")
	}
	return filepath.Join(la, "DFTrainer") // kept from before the rename: settings, keys and versions stay where they are
}

func extraNodePaths() []string {
	var out []string
	for _, env := range []string{"ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"} {
		if d := os.Getenv(env); d != "" {
			out = append(out, filepath.Join(d, "nodejs", "node.exe"))
		}
	}
	return out
}

func samePath(a, b string) bool {
	return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
}

func processAlive(pid int) bool {
	h, err := syscall.OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, uint32(pid))
	if err != nil {
		return false
	}
	defer syscall.CloseHandle(h)
	var code uint32
	if syscall.GetExitCodeProcess(h, &code) != nil {
		return false
	}
	return code == stillActive
}

func killProcess(pid int) {
	h, err := syscall.OpenProcess(0x0001 /* PROCESS_TERMINATE */, false, uint32(pid))
	if err != nil {
		return
	}
	defer syscall.CloseHandle(h)
	_ = syscall.TerminateProcess(h, 1)
}

// hidden, and in its own group so it keeps running after the launcher exits
func hideAndDetach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow | createNewProcessGroup}
}

func startDetached(exe string, args []string) error {
	cmd := exec.Command(exe, args...)
	cmd.Dir = filepath.Dir(exe)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNewProcessGroup}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

func messageBox(title, text string, flags uintptr) int {
	t, _ := syscall.UTF16PtrFromString(title)
	m, _ := syscall.UTF16PtrFromString(text)
	ret, _, _ := messageBoxW.Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)), flags)
	return int(ret)
}
func showError(title, text string) {
	messageBox(title, text, 0x10|0x10000 /* MB_ICONERROR|MB_SETFOREGROUND */)
}
func showInfo(title, text string) { messageBox(title, text, 0x40|0x10000) }
func confirm(title, text string) bool {
	return messageBox(title, text, 0x4|0x20|0x100|0x10000 /* YESNO|QUESTION|DEFBUTTON2|SETFOREGROUND */) == 6
}

// ------------------------------------------------------------------ shortcuts, Apps & features, uninstall, links
// All through the Windows API directly (shell links over COM, the registry API, ShellExecute). No PowerShell, reg.exe,
// cmd or rundll32: scripts and system tools started hidden are what antivirus heuristics look for.

type guid struct {
	d1     uint32
	d2, d3 uint16
	d4     [8]byte
}

var (
	ole32                = syscall.NewLazyDLL("ole32.dll")
	procCoInitializeEx   = ole32.NewProc("CoInitializeEx")
	procCoUninitialize   = ole32.NewProc("CoUninitialize")
	procCoCreateInstance = ole32.NewProc("CoCreateInstance")

	clsidShellLink = guid{0x00021401, 0, 0, [8]byte{0xC0, 0, 0, 0, 0, 0, 0, 0x46}}
	iidShellLinkW  = guid{0x000214F9, 0, 0, [8]byte{0xC0, 0, 0, 0, 0, 0, 0, 0x46}}
	iidPersistFile = guid{0x0000010B, 0, 0, [8]byte{0xC0, 0, 0, 0, 0, 0, 0, 0x46}}
)

// comCall calls method i of a COM object's vtable
func comCall(obj uintptr, i int, args ...uintptr) uintptr {
	vtbl := *(*uintptr)(unsafe.Pointer(obj))
	fn := *(*uintptr)(unsafe.Pointer(vtbl + uintptr(i)*unsafe.Sizeof(uintptr(0))))
	r, _, _ := syscall.SyscallN(fn, append([]uintptr{obj}, args...)...)
	return r
}

// wstr: s as a UTF-16 string for a COM call, kept in keep: a uintptr alone does not keep the string alive, so the
// caller holds keep (runtime.KeepAlive) until its last COM call
func wstr(keep *[]*uint16, s string) uintptr {
	p, _ := syscall.UTF16PtrFromString(s)
	*keep = append(*keep, p)
	return uintptr(unsafe.Pointer(p))
}

// writeShortcut saves a .lnk at path pointing at exe (IShellLinkW + IPersistFile)
func writeShortcut(path, exe, description string) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if hr, _, _ := procCoInitializeEx.Call(0, 2 /* COINIT_APARTMENTTHREADED */); hr == 0 || hr == 1 {
		defer procCoUninitialize.Call()
	}
	var link uintptr
	if hr, _, _ := procCoCreateInstance.Call(uintptr(unsafe.Pointer(&clsidShellLink)), 0, 1 /* CLSCTX_INPROC_SERVER */, uintptr(unsafe.Pointer(&iidShellLinkW)), uintptr(unsafe.Pointer(&link))); hr != 0 || link == 0 {
		return fmt.Errorf("shell link: 0x%x", uint32(hr))
	}
	var keep []*uint16
	defer func() { runtime.KeepAlive(keep) }()
	defer comCall(link, 2)                           // Release
	comCall(link, 20, wstr(&keep, exe))              // SetPath
	comCall(link, 9, wstr(&keep, filepath.Dir(exe))) // SetWorkingDirectory
	comCall(link, 7, wstr(&keep, description))       // SetDescription
	comCall(link, 17, wstr(&keep, exe), 0)           // SetIconLocation
	var pf uintptr
	if hr := comCall(link, 0, uintptr(unsafe.Pointer(&iidPersistFile)), uintptr(unsafe.Pointer(&pf))); hr != 0 || pf == 0 {
		return fmt.Errorf("persist file: 0x%x", uint32(hr))
	}
	defer comCall(pf, 2)
	if hr := comCall(pf, 6, wstr(&keep, path), 1); hr != 0 { // Save
		return fmt.Errorf("save %s: 0x%x", path, uint32(hr))
	}
	return nil
}

func shortcutDirs() []string {
	var out []string
	for _, id := range []*windows.KNOWNFOLDERID{windows.FOLDERID_Desktop, windows.FOLDERID_Programs} {
		if d, err := windows.KnownFolderPath(id, 0); err == nil && d != "" {
			out = append(out, d)
		}
	}
	return out
}

// Start Menu and Desktop shortcuts (the one from before the rename goes)
func createShortcuts(exe string) error {
	var firstErr error
	for _, d := range shortcutDirs() {
		_ = os.Remove(filepath.Join(d, "DF Trainer.lnk"))
		if err := writeShortcut(filepath.Join(d, "Lantern Client.lnk"), exe, "Lantern Client for Dauntless Forever"); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}
func removeShortcuts() {
	for _, d := range shortcutDirs() {
		for _, n := range []string{"Lantern Client.lnk", "DF Trainer.lnk"} {
			_ = os.Remove(filepath.Join(d, n))
		}
	}
}

// "Apps & features" entry for this user (no admin rights needed)
const uninstallSubkey = `Software\Microsoft\Windows\CurrentVersion\Uninstall\DFTrainer` // kept from before the rename, so the entry is updated, not doubled

func registerUninstall(exe, version string) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, uninstallSubkey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	for _, v := range [][2]string{
		{"DisplayName", "Lantern Client"}, {"DisplayVersion", version}, {"Publisher", "Alex"},
		{"DisplayIcon", exe + ",0"}, {"InstallLocation", filepath.Dir(exe)}, {"UninstallString", fmt.Sprintf(`"%s" --uninstall`, exe)},
	} {
		if err := k.SetStringValue(v[0], v[1]); err != nil {
			return err
		}
	}
	for _, v := range []struct {
		n string
		d uint32
	}{{"NoModify", 1}, {"NoRepair", 1}, {"EstimatedSize", 20480}} {
		if err := k.SetDWordValue(v.n, v.d); err != nil {
			return err
		}
	}
	return nil
}
func unregisterUninstall() { _ = registry.DeleteKey(registry.CURRENT_USER, uninstallSubkey) }

// scheduleDelete removes the install folder. This exe is running from it, so it first moves itself to the temp folder
// (Windows lets a running exe be moved, not deleted), where it is removed at the next restart or by Disk Clean-up.
func scheduleDelete(dir string) {
	if self, err := os.Executable(); err == nil {
		tmp := filepath.Join(os.TempDir(), fmt.Sprintf("lantern-client-removed-%d.exe", time.Now().UnixNano()))
		if os.Rename(self, tmp) == nil {
			if p, err := syscall.UTF16PtrFromString(tmp); err == nil {
				_ = windows.MoveFileEx(p, nil, windows.MOVEFILE_DELAY_UNTIL_REBOOT) // works only with admin rights; fine if not
			}
		}
	}
	for i := 0; i < 20; i++ { // the panel or the window may still be letting go of files for a moment
		if os.RemoveAll(dir) == nil {
			return
		}
		time.Sleep(250 * time.Millisecond)
	}
}

// openURL opens a web page in the default browser (https only)
func openURL(u string) {
	if !strings.HasPrefix(u, "https://") {
		return
	}
	verb, _ := syscall.UTF16PtrFromString("open")
	file, _ := syscall.UTF16PtrFromString(u)
	_ = windows.ShellExecute(0, verb, file, nil, nil, 1 /* SW_SHOWNORMAL */)
}
