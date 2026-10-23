// mkres writes the launcher's Windows resources (icon, application manifest, version info) as a COFF object
// (rsrc_windows_amd64.syso) that the Go linker puts into the exe. Standard library only.
//
//	go run ./cmd/mkres -ico icon.ico -version 1.0.0 -app 1.1.0 -o rsrc_windows_amd64.syso
package main

import (
	"bytes"
	"encoding/binary"
	"flag"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

const (
	rtIcon      = 3
	rtGroupIcon = 14
	rtVersion   = 16
	rtManifest  = 24
	langEnUS    = 0x0409
)

type res struct {
	typ, id uint32
	data    []byte
}

func main() {
	ico := flag.String("ico", "icon.ico", "icon file")
	ver := flag.String("version", "1.0.0", "launcher version")
	app := flag.String("app", "", "app version it carries (shown as product version)")
	out := flag.String("o", "rsrc_windows_amd64.syso", "output")
	flag.Parse()

	var all []res
	icons, group, err := readIco(*ico)
	if err != nil {
		fail(err)
	}
	for i, d := range icons {
		all = append(all, res{rtIcon, uint32(i + 1), d})
	}
	all = append(all, res{rtGroupIcon, 1, group})
	pv := *ver
	if *app != "" {
		pv = *app
	}
	all = append(all, res{rtVersion, 1, versionInfo(*ver, pv)})
	all = append(all, res{rtManifest, 1, []byte(manifest(*ver))})
	if err := os.WriteFile(*out, coff(all), 0o644); err != nil {
		fail(err)
	}
	fmt.Printf("wrote %s (%d resources)\n", *out, len(all))
}

func fail(err error) { fmt.Fprintln(os.Stderr, err); os.Exit(1) }

// ------------------------------------------------------------------ icon: .ico -> RT_ICON images + RT_GROUP_ICON

func readIco(path string) ([][]byte, []byte, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, err
	}
	if len(b) < 6 || binary.LittleEndian.Uint16(b[2:]) != 1 {
		return nil, nil, fmt.Errorf("%s is not an .ico file", path)
	}
	n := int(binary.LittleEndian.Uint16(b[4:]))
	var images [][]byte
	var grp bytes.Buffer
	binary.Write(&grp, binary.LittleEndian, [3]uint16{0, 1, uint16(n)})
	for i := 0; i < n; i++ {
		e := b[6+16*i : 6+16*(i+1)]
		size := binary.LittleEndian.Uint32(e[8:])
		off := binary.LittleEndian.Uint32(e[12:])
		if int(off+size) > len(b) {
			return nil, nil, fmt.Errorf("broken icon entry %d", i)
		}
		images = append(images, b[off:off+size])
		grp.Write(e[:12])                                    // width .. bytes in resource
		binary.Write(&grp, binary.LittleEndian, uint16(i+1)) // resource id instead of file offset
	}
	return images, grp.Bytes(), nil
}

// ------------------------------------------------------------------ manifest: no admin prompt, sharp on high DPI

func manifest(ver string) string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity type="win32" name="DFTrainer.Launcher" version="` + quad(ver) + `" processorArchitecture="amd64"/>
  <description>DF Trainer</description>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security><requestedPrivileges><requestedExecutionLevel level="asInvoker" uiAccess="false"/></requestedPrivileges></security>
  </trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application><supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/></application>
  </compatibility>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2</dpiAwareness>
    </windowsSettings>
  </application>
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/>
    </dependentAssembly>
  </dependency>
</assembly>
`
}

func verParts(v string) [4]uint16 {
	var out [4]uint16
	for i, p := range strings.SplitN(strings.TrimPrefix(v, "v"), ".", 4) {
		n, _ := strconv.Atoi(p)
		out[i] = uint16(n)
	}
	return out
}
func quad(v string) string {
	p := verParts(v)
	return fmt.Sprintf("%d.%d.%d.%d", p[0], p[1], p[2], p[3])
}

// ------------------------------------------------------------------ version info (VS_VERSIONINFO)

func u16z(s string) []byte {
	var b bytes.Buffer
	for _, r := range utf16.Encode([]rune(s)) {
		binary.Write(&b, binary.LittleEndian, r)
	}
	b.Write([]byte{0, 0})
	return b.Bytes()
}
func pad4(b *bytes.Buffer) {
	for b.Len()%4 != 0 {
		b.WriteByte(0)
	}
}

// block: wLength, wValueLength, wType, szKey, padding, Value, padding, Children (each 4-aligned)
func block(key string, value []byte, valueLen, typ uint16, children ...[]byte) []byte {
	var b bytes.Buffer
	binary.Write(&b, binary.LittleEndian, [3]uint16{0, valueLen, typ})
	b.Write(u16z(key))
	pad4(&b)
	b.Write(value)
	for _, c := range children {
		pad4(&b)
		b.Write(c)
	}
	out := b.Bytes()
	binary.LittleEndian.PutUint16(out, uint16(len(out)))
	return out
}

func versionInfo(fileVer, productVer string) []byte {
	fv, pv := verParts(fileVer), verParts(productVer)
	var fixed bytes.Buffer
	binary.Write(&fixed, binary.LittleEndian, []uint32{
		0xFEEF04BD, 0x00010000,
		uint32(fv[0])<<16 | uint32(fv[1]), uint32(fv[2])<<16 | uint32(fv[3]),
		uint32(pv[0])<<16 | uint32(pv[1]), uint32(pv[2])<<16 | uint32(pv[3]),
		0x3F, 0, 0x00040004 /* VOS_NT_WINDOWS32 */, 1 /* VFT_APP */, 0, 0, 0,
	})
	strs := [][2]string{
		{"CompanyName", "Alex"},
		{"FileDescription", "DF Trainer"},
		{"FileVersion", quad(fileVer)},
		{"InternalName", "DF Trainer"},
		{"LegalCopyright", "AGPL-3.0-only"},
		{"OriginalFilename", "DF Trainer.exe"},
		{"ProductName", "DF Trainer"},
		{"ProductVersion", productVer},
	}
	var strings_ [][]byte
	for _, s := range strs {
		v := u16z(s[1])
		strings_ = append(strings_, block(s[0], v, uint16(len(v)/2), 1))
	}
	table := block("040904B0", nil, 0, 1, strings_...)
	sfi := block("StringFileInfo", nil, 0, 1, table)
	trans := []byte{0x09, 0x04, 0xB0, 0x04}
	vfi := block("VarFileInfo", nil, 0, 1, block("Translation", trans, 4, 0))
	return block("VS_VERSION_INFO", fixed.Bytes(), uint16(fixed.Len()), 0, sfi, vfi)
}

// ------------------------------------------------------------------ COFF object with one .rsrc section

func coff(all []res) []byte {
	sort.Slice(all, func(i, j int) bool {
		if all[i].typ != all[j].typ {
			return all[i].typ < all[j].typ
		}
		return all[i].id < all[j].id
	})
	var types []uint32
	byType := map[uint32][]res{}
	for _, r := range all {
		if len(byType[r.typ]) == 0 {
			types = append(types, r.typ)
		}
		byType[r.typ] = append(byType[r.typ], r)
	}

	// layout: root dir, type dirs, name dirs, data entries, data
	off := 16 + 8*len(types)
	typeOff := map[uint32]int{}
	for _, t := range types {
		typeOff[t] = off
		off += 16 + 8*len(byType[t])
	}
	nameOff := map[[2]uint32]int{}
	for _, t := range types {
		for _, r := range byType[t] {
			nameOff[[2]uint32{t, r.id}] = off
			off += 16 + 8
		}
	}
	entryOff := map[[2]uint32]int{}
	for _, t := range types {
		for _, r := range byType[t] {
			entryOff[[2]uint32{t, r.id}] = off
			off += 16
		}
	}
	dataOff := map[[2]uint32]int{}
	for _, t := range types {
		for _, r := range byType[t] {
			off = (off + 7) &^ 7
			dataOff[[2]uint32{t, r.id}] = off
			off += len(r.data)
		}
	}
	raw := make([]byte, (off+7)&^7)
	le := binary.LittleEndian
	dir := func(at, ids int) { le.PutUint16(raw[at+14:], uint16(ids)) }
	entry := func(at int, id, target uint32) { le.PutUint32(raw[at:], id); le.PutUint32(raw[at+4:], target) }

	dir(0, len(types))
	for i, t := range types {
		entry(16+8*i, t, 0x80000000|uint32(typeOff[t]))
		dir(typeOff[t], len(byType[t]))
		for j, r := range byType[t] {
			k := [2]uint32{t, r.id}
			entry(typeOff[t]+16+8*j, r.id, 0x80000000|uint32(nameOff[k]))
			dir(nameOff[k], 1)
			entry(nameOff[k]+16, langEnUS, uint32(entryOff[k]))
			le.PutUint32(raw[entryOff[k]:], uint32(dataOff[k])) // relocated to an RVA by the linker
			le.PutUint32(raw[entryOff[k]+4:], uint32(len(r.data)))
			copy(raw[dataOff[k]:], r.data)
		}
	}

	var relocs []int
	for _, t := range types {
		for _, r := range byType[t] {
			relocs = append(relocs, entryOff[[2]uint32{t, r.id}])
		}
	}
	var o bytes.Buffer
	symOff := 20 + 40 + len(raw) + 10*len(relocs)
	binary.Write(&o, le, uint16(0x8664)) // AMD64
	binary.Write(&o, le, uint16(1))      // sections
	binary.Write(&o, le, uint32(0))      // timestamp
	binary.Write(&o, le, uint32(symOff)) // symbol table
	binary.Write(&o, le, uint32(1))      // symbols
	binary.Write(&o, le, uint16(0))      // optional header
	binary.Write(&o, le, uint16(0))      // characteristics
	o.Write([]byte(".rsrc\x00\x00\x00"))
	binary.Write(&o, le, []uint32{0, 0, uint32(len(raw)), 60, uint32(60 + len(raw)), 0})
	binary.Write(&o, le, uint16(len(relocs)))
	binary.Write(&o, le, uint16(0))
	binary.Write(&o, le, uint32(0x40000040)) // initialized data, readable
	o.Write(raw)
	for _, r := range relocs {
		binary.Write(&o, le, uint32(r))
		binary.Write(&o, le, uint32(0))
		binary.Write(&o, le, uint16(3)) // IMAGE_REL_AMD64_ADDR32NB
	}
	o.Write([]byte(".rsrc\x00\x00\x00"))
	binary.Write(&o, le, uint32(0))
	binary.Write(&o, le, int16(1))
	binary.Write(&o, le, uint16(0))
	o.WriteByte(3) // static
	o.WriteByte(0)
	binary.Write(&o, le, uint32(4)) // empty string table
	return o.Bytes()
}
