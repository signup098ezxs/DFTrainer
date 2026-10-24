Copied third-party code (so the launcher builds with the standard library alone, no downloads):
  webview2   github.com/jchv/go-webview2  @ 56598839c808 (MIT, see webview2/LICENSE)
  winloader  github.com/jchv/go-winloader (ISC, see winloader/LICENSE.md)
  xsys       golang.org/x/sys v0.30.0, the windows packages only (BSD-3-Clause, see xsys/LICENSE)
Only the import paths were changed (to point here).
  ximage     golang.org/x/image @ a998c07, font, font/sfnt, font/opentype, vector and math/fixed only (BSD-3-Clause,
             see ximage/LICENSE): text in the behemoth overlay. sfnt's two uses of golang.org/x/text's Mac Roman charmap
             are replaced by ASCII (not needed by the embedded fonts), and vector uses its portable code only
             (its amd64 assembly needs golang.org/x/sys/cpu).
