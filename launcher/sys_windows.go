//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

const (
	exeName     = "DF Trainer.exe"
	nodeExeName = "node.exe"

	createNoWindow        = 0x08000000
	createNewProcessGroup = 0x00000200
	stillActive           = 259
	uninstallKey          = `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\DFTrainer`
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
	return filepath.Join(la, "DFTrainer")
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

func runHidden(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	return cmd.Run()
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

// Start Menu and Desktop shortcuts, through the Windows shell (the exe path goes in an environment variable, so no
// quoting can go wrong)
const shortcutScript = `$s = New-Object -ComObject WScript.Shell
foreach ($d in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  if (-not $d) { continue }
  $l = $s.CreateShortcut((Join-Path $d 'DF Trainer.lnk'))
  $l.TargetPath = $env:DFT_EXE
  $l.WorkingDirectory = (Split-Path -Parent $env:DFT_EXE)
  $l.IconLocation = $env:DFT_EXE + ',0'
  $l.Description = 'DF Trainer for Dauntless Forever'
  $l.Save()
}`
const removeShortcutScript = `foreach ($d in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  if ($d) { Remove-Item -LiteralPath (Join-Path $d 'DF Trainer.lnk') -ErrorAction SilentlyContinue }
}`

func powershell(script string, env ...string) error {
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
	cmd.Env = append(os.Environ(), env...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	return cmd.Run()
}
func createShortcuts(exe string) error { return powershell(shortcutScript, "DFT_EXE="+exe) }
func removeShortcuts()                 { _ = powershell(removeShortcutScript) }

// "Apps & features" entry for this user (no admin rights needed)
func registerUninstall(exe, version string) error {
	vals := [][3]string{
		{"DisplayName", "REG_SZ", "DF Trainer"},
		{"DisplayVersion", "REG_SZ", version},
		{"Publisher", "REG_SZ", "Alex"},
		{"DisplayIcon", "REG_SZ", exe + ",0"},
		{"InstallLocation", "REG_SZ", filepath.Dir(exe)},
		{"UninstallString", "REG_SZ", fmt.Sprintf(`"%s" --uninstall`, exe)},
		{"NoModify", "REG_DWORD", "1"},
		{"NoRepair", "REG_DWORD", "1"},
		{"EstimatedSize", "REG_DWORD", "2048"},
	}
	for _, v := range vals {
		if err := runHidden("reg.exe", "add", uninstallKey, "/v", v[0], "/t", v[1], "/d", v[2], "/f"); err != nil {
			return err
		}
	}
	return nil
}
func unregisterUninstall() { _ = runHidden("reg.exe", "delete", uninstallKey, "/f") }

// the folder holds this running exe, so a hidden cmd deletes it a moment after we exit
func scheduleDelete(dir string) {
	cmd := exec.Command("cmd.exe")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow | createNewProcessGroup,
		CmdLine: fmt.Sprintf(`cmd.exe /c ping -n 3 127.0.0.1 >nul & rmdir /s /q "%s"`, dir)}
	_ = cmd.Start()
}
