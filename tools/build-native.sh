#!/usr/bin/env bash
# Builds the native tracker DLL (native/lantern_native.cpp + MinHook) into the game mod's folder, where the app zip
# picks it up. Needs mingw-w64 (Ubuntu: apt-get install g++-mingw-w64-x86-64). Run from the repository root.
set -euo pipefail
OUT=app/mod/DFTrainer/native
OBJ=build-native
mkdir -p "$OUT" "$OBJ"
for f in hook buffer trampoline hde/hde64; do
  x86_64-w64-mingw32-gcc -O2 -c "native/minhook/$f.c" -o "$OBJ/$(basename "$f").o"
done
x86_64-w64-mingw32-g++ -shared -O2 -std=c++17 -fno-exceptions -fno-rtti -static -static-libgcc -static-libstdc++ \
  -o "$OUT/lantern_native.dll" native/lantern_native.cpp "$OBJ"/*.o -luser32 -lkernel32
x86_64-w64-mingw32-strip "$OUT/lantern_native.dll"
ls -l "$OUT/lantern_native.dll"
