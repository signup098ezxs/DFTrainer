package main

// Updates come from GitHub Releases. Each release has a small manifest, dftrainer-manifest.json (its name and the
// signature prefix stay from before the rename, so older launchers keep updating):
//
//   { "version": "1.2.0", "notes": "...",
//     "app":      { "file": "LanternClient-app-1.2.0.zip", "sha256": "...", "size": 123 },
//     "launcher": { "version": "1.0.0", "file": "Lantern-Client-Setup.exe", "sha256": "...", "size": 456 },
//     "signature": "<base64 Ed25519 signature>" }
//
// The signature covers every field that decides what gets installed (see signedMessage). Its key's public half is
// built into this exe, so a release only installs if it was signed with the project's private key, and every
// downloaded file must match its size and SHA-256. Nothing else from the internet is ever run.

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Asset struct {
	File    string `json:"file"`
	SHA256  string `json:"sha256"`
	Size    int64  `json:"size"`
	Version string `json:"version,omitempty"`
}
type Manifest struct {
	Version   string `json:"version"`
	Notes     string `json:"notes"`
	App       Asset  `json:"app"`
	Launcher  Asset  `json:"launcher"`
	Signature string `json:"signature"`
}

func signedMessage(m Manifest) []byte {
	return []byte(strings.Join([]string{"dftrainer-release-v1", m.Version,
		m.App.File, m.App.SHA256, fmt.Sprint(m.App.Size),
		m.Launcher.Version, m.Launcher.File, m.Launcher.SHA256, fmt.Sprint(m.Launcher.Size)}, "\n"))
}
func verifyManifest(m Manifest) error {
	key, err := base64.StdEncoding.DecodeString(pubKeyB64)
	if err != nil || len(key) != ed25519.PublicKeySize {
		return errors.New("this launcher has no release key, so it cannot update")
	}
	sig, err := base64.StdEncoding.DecodeString(m.Signature)
	if err != nil || !ed25519.Verify(ed25519.PublicKey(key), signedMessage(m), sig) {
		return errors.New("the update's signature does not match: it was not installed")
	}
	if !verRe.MatchString(m.Version) {
		return errors.New("the update has a bad version number")
	}
	return nil
}

type Result struct {
	OK              bool   `json:"ok"`
	Current         string `json:"current"`
	Latest          string `json:"latest,omitempty"`
	Available       bool   `json:"available"`
	Applied         bool   `json:"applied"`
	From            string `json:"from,omitempty"`
	To              string `json:"to,omitempty"`
	Notes           string `json:"notes,omitempty"`
	LauncherUpdated bool   `json:"launcherUpdated,omitempty"`
	Error           string `json:"error,omitempty"`
}

func (r Result) summary() string {
	switch {
	case r.Error != "":
		return "failed: " + r.Error
	case r.Applied:
		return fmt.Sprintf("installed %s (was %s)", r.To, r.From)
	case r.LauncherUpdated:
		return "launcher updated"
	case r.Available:
		return "available: " + r.Latest
	default:
		return "up to date (" + r.Current + ")"
	}
}

// the update channel: release.json of the installed app can name it, else the one built in
func updateRepo(current string) string {
	var rel struct {
		Repo string `json:"repo"`
	}
	if b, err := os.ReadFile(filepath.Join(appDir(current), "release.json")); err == nil && json.Unmarshal(b, &rel) == nil && validRepo(rel.Repo) {
		return rel.Repo
	}
	if validRepo(defaultRepo) {
		return defaultRepo
	}
	return ""
}
func validRepo(r string) bool {
	p := strings.Split(r, "/")
	return len(p) == 2 && p[0] != "" && p[1] != "" && !strings.ContainsAny(r, " ?#\\")
}
func apiBase() string {
	if a := os.Getenv("DFT_API"); a != "" { // tests only
		return strings.TrimRight(a, "/")
	}
	return "https://api.github.com"
}

type ghRelease struct {
	TagName string `json:"tag_name"`
	Assets  []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
		Size int64  `json:"size"`
	} `json:"assets"`
}

func httpGet(ctx context.Context, url string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "LanternClient-Launcher/"+launcherVersion)
	if strings.Contains(url, "api.github.com") || strings.HasPrefix(url, apiBase()) {
		req.Header.Set("Accept", "application/vnd.github+json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, errNotFound
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s answered %d", hostOf(url), resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, errors.New("download larger than expected")
	}
	return b, nil
}

var errNotFound = errors.New("no release published yet")

func hostOf(u string) string {
	u = strings.TrimPrefix(strings.TrimPrefix(u, "https://"), "http://")
	if i := strings.IndexByte(u, '/'); i >= 0 {
		return u[:i]
	}
	return u
}

// fetchLatest reads the latest release and its verified manifest
func fetchLatest(ctx context.Context, repo string) (Manifest, map[string]string, error) {
	var m Manifest
	b, err := httpGet(ctx, apiBase()+"/repos/"+repo+"/releases/latest", 2<<20)
	if err != nil {
		return m, nil, err
	}
	var rel ghRelease
	if err := json.Unmarshal(b, &rel); err != nil {
		return m, nil, err
	}
	urls := map[string]string{}
	for _, a := range rel.Assets {
		urls[a.Name] = a.URL
	}
	mu, ok := urls["dftrainer-manifest.json"]
	if !ok {
		return m, nil, errors.New("the latest release has no dftrainer-manifest.json")
	}
	mb, err := httpGet(ctx, mu, 1<<20)
	if err != nil {
		return m, nil, err
	}
	if err := json.Unmarshal(mb, &m); err != nil {
		return m, nil, errors.New("the release manifest is not readable")
	}
	if err := verifyManifest(m); err != nil {
		return m, nil, err
	}
	return m, urls, nil
}

func download(ctx context.Context, urls map[string]string, a Asset) ([]byte, error) {
	u, ok := urls[a.File]
	if !ok {
		return nil, fmt.Errorf("the release is missing %s", a.File)
	}
	b, err := httpGet(ctx, u, a.Size)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(b)
	if int64(len(b)) != a.Size || !strings.EqualFold(hex.EncodeToString(sum[:]), a.SHA256) {
		return nil, fmt.Errorf("%s did not match its signed checksum: it was not installed", a.File)
	}
	return b, nil
}

// lock: the launcher and the panel may both look for updates; only one installs at a time. The lock holds its
// owner's process id: an update that was stopped part way (its process killed when the panel restarted, or the PC
// shut down) leaves the file behind, and a lock whose owner is no longer running is cleared at once instead of
// blocking every update for the next 15 minutes ("Could not check for updates: another update is running").
func takeLock() (func(), bool) {
	p := filepath.Join(rootDir(), "update.lock")
	for try := 0; try < 2; try++ {
		f, err := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err == nil {
			fmt.Fprintf(f, "%d", os.Getpid())
			f.Close()
			return func() { _ = os.Remove(p) }, true
		}
		if !lockStale(p) {
			return nil, false
		}
		logf("update: cleared a lock left by an update that was stopped")
		_ = os.Remove(p)
	}
	return nil, false
}

// lockStale: the lock's owner is not running any more, or it is older than any update can take
func lockStale(p string) bool {
	st, err := os.Stat(p)
	if err != nil {
		return true
	}
	if time.Since(st.ModTime()) > 7*time.Minute { // the longest update (download 5 min) is over by then
		return true
	}
	b, _ := os.ReadFile(p)
	pid, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || pid <= 0 {
		// an empty lock (written by launchers before 1.6.10, which did not record their process): its owner may still
		// be downloading, so only the age counts (above)
		return false
	}
	return pid != os.Getpid() && !processAlive(pid)
}

func checkOnly(timeout time.Duration) Result {
	st := loadState()
	r := Result{Current: st.Current}
	repo := updateRepo(st.Current)
	if repo == "" {
		r.Error = "no update channel set"
		return r
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	m, _, err := fetchLatest(ctx, repo)
	if err != nil {
		if errors.Is(err, errNotFound) {
			r.OK = true
			return r
		}
		r.Error = err.Error()
		return r
	}
	r.OK, r.Latest, r.Notes = true, m.Version, m.Notes
	r.Available = semverCmp(m.Version, st.Current) > 0 && !st.isBad(m.Version)
	return r
}

// stageUpdate installs a newer version (and launcher) if there is one. The new app version becomes current for the
// next start; a panel that is running keeps running its own files until it restarts.
func stageUpdate(checkTimeout, downloadTimeout time.Duration) Result {
	st := loadState()
	r := Result{Current: st.Current}
	repo := updateRepo(st.Current)
	if repo == "" {
		r.OK = true
		r.Error = "no update channel set"
		return r
	}
	unlock, ok := takeLock()
	if !ok {
		r.Error = "another update is running"
		return r
	}
	defer unlock()

	ctx, cancel := context.WithTimeout(context.Background(), checkTimeout)
	m, urls, err := fetchLatest(ctx, repo)
	cancel()
	if err != nil {
		if errors.Is(err, errNotFound) {
			r.OK = true
			return r
		}
		r.Error = err.Error()
		return r
	}
	r.OK, r.Latest, r.Notes = true, m.Version, m.Notes
	dctx, dcancel := context.WithTimeout(context.Background(), downloadTimeout)
	defer dcancel()

	// the launcher itself
	if m.Launcher.Version != "" && semverCmp(m.Launcher.Version, launcherVersion) > 0 {
		if b, err := download(dctx, urls, m.Launcher); err != nil {
			r.Error = "launcher: " + err.Error()
		} else if err := replaceLauncher(b); err != nil {
			r.Error = "launcher: " + err.Error()
		} else {
			r.LauncherUpdated = true
			logf("launcher updated to %s", m.Launcher.Version)
		}
	}

	// the app
	st = loadState()
	if semverCmp(m.Version, st.Current) <= 0 || st.isBad(m.Version) {
		return r
	}
	r.Available = true
	if !versionReady(m.Version) {
		b, err := download(dctx, urls, m.App)
		if err != nil {
			r.Error = err.Error()
			return r
		}
		if err := installAppZip(b, m.Version); err != nil {
			r.Error = "could not unpack the update: " + err.Error()
			return r
		}
	}
	st = loadState()
	r.From = st.Current
	st.Previous, st.Current = st.Current, m.Version
	if err := saveState(st); err != nil {
		r.Error = err.Error()
		return r
	}
	_ = writeAtomic(updateNotePath(), mustJSON(map[string]any{"from": r.From, "to": m.Version, "notes": m.Notes, "at": time.Now().Unix()}))
	_ = registerUninstall(installedExe(), m.Version)
	prune(st)
	r.Applied, r.To = true, m.Version
	logf("installed %s (was %s)", m.Version, r.From)
	return r
}

// replaceLauncher swaps in a new launcher exe. Windows lets a running exe be renamed but not overwritten.
func replaceLauncher(b []byte) error {
	exe := installedExe()
	tmp := exe + ".new"
	if err := os.WriteFile(tmp, b, 0o755); err != nil {
		return err
	}
	old := strings.TrimSuffix(exe, filepath.Ext(exe)) + ".old" + filepath.Ext(exe)
	_ = os.Remove(old)
	if fileExists(exe) {
		if err := os.Rename(exe, old); err != nil {
			_ = os.Remove(tmp)
			return err
		}
	}
	if err := os.Rename(tmp, exe); err != nil {
		_ = os.Rename(old, exe)
		return err
	}
	return nil
}
