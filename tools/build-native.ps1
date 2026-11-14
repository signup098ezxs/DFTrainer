# Local test build of the native DLL on Windows (the release build is tools/build-native.sh in CI, with mingw-w64).
# Needs Python with the zig compiler package: pip install ziglang. Run from the repository root:
#   powershell -File tools\build-native.ps1 [-Out <folder>]
param([string]$Out = "build-native")
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force $Out | Out-Null
$objs = @()
foreach ($f in "hook", "buffer", "trampoline", "hde/hde64") {
    $o = Join-Path $Out ((Split-Path $f -Leaf) + ".o")
    python -m ziglang cc -target x86_64-windows-gnu -O2 -c "native/minhook/$f.c" -o $o
    if ($LASTEXITCODE) { throw "minhook/$f.c did not compile" }
    $objs += $o
}
python -m ziglang c++ -target x86_64-windows-gnu -shared -O2 -std=c++17 -fno-exceptions -fno-rtti `
    -o (Join-Path $Out "lantern_native.dll") native/lantern_native.cpp @objs -luser32 -lkernel32
if ($LASTEXITCODE) { throw "lantern_native.cpp did not compile" }
Get-Item (Join-Path $Out "lantern_native.dll") | Select-Object Name, Length
