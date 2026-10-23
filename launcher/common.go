package main

import (
	"net/http"
	"os"
	"time"
)

// pingPanel: is a panel answering at this address (its own page, with its token)?
func pingPanel(url string) bool {
	c := http.Client{Timeout: 1500 * time.Millisecond}
	resp, err := c.Get(url)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// uninstall removes the panel, its shortcuts and its Apps & features entry. The game, its save and the DF Trainer
// game mod are not touched (the launcher's Mods page turns the mod off).
func uninstall() {
	if !confirm("Remove DF Trainer?", "This removes the DF Trainer panel and its shortcuts.\n\nYour game, your save and the DF Trainer game mod stay as they are (turn the mod off on the Dauntless Forever launcher's Mods page).") {
		return
	}
	if r, ok := readRunning(); ok {
		killProcess(r.Pid)
	}
	removeShortcuts()
	unregisterUninstall()
	logf("uninstalled")
	scheduleDelete(rootDir())
	showInfo("DF Trainer", "DF Trainer was removed.")
	os.Exit(0)
}
