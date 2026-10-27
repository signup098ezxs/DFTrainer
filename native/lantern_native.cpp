// SPDX-License-Identifier: AGPL-3.0-only
// Lantern Client native tracker for Dauntless 1.14.7 (3.9.25 owner's test; 3.9.26 feeds Lantern's card for everyone; 3.9.28 sticky target, breaks per behemoth).
//
// Does what Dauntless Forever's Boss Health Bar does (its loader bin\dxgi.dll, source d1147.cpp in the package's
// source\Loader1147-*-source.zip, AGPL-3.0-only; the 1.14.7 addresses, the actor walk, the part links and the fenced
// call below come from it), but draws nothing: it writes the behemoth to track\native.json in the Lantern mod's
// folder, which the panel reads like the Lua mod's track files and shows on Lantern's own card.
// Why native: the Lua mod finds behemoths by searching every game object (20-165 ms each on the game's thread), which
// made co-op stutter. This walks the world's actor lists directly, a few times a second, like DF's bar.
//
// Loaded by the Lantern Lua mod (package.loadlib) while Lantern's card is on; it reads trainer-toggles.json itself
// ("native":true) and stays idle otherwise. While its file is fresh the Lua mod tracks nothing. Only your own game does anything: a copy with no local player (a hunt
// server) writes nothing. Log: logs\native-<date>-<process>.log in the mod's folder.
//
// Build (CI, tools/build.mjs runs it): x86_64-w64-mingw32-g++ -shared -O2 -static ... (see the build script)
#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <stdarg.h>
#include <string.h>
#include <wchar.h>
#include <wctype.h>
#include <time.h>
#include "minhook/MinHook.h"

// ---------------------------------------------------------------------------- 1.14.7 addresses (from d1147.cpp)
namespace A {
    const uintptr_t LoadMapListenCall    = 0x4272A80;  // a known call: its bytes tell this is the 1.14.7 exe
    const uintptr_t GameEngineTick       = 0x3E10AB0;  // UGameEngine::Tick(float, bool)
    const uintptr_t GWorld               = 0x6FC7F58;
    const uintptr_t AppendString         = 0x2656410;  // FName::AppendString(FString&)
    const uintptr_t ProcessEvent         = 0x2861880;  // UObject::ProcessEvent(UFunction*, void* Parms)
    const uintptr_t Struct_Super         = 0x40;
    const uintptr_t Struct_Children      = 0x48;
    const uintptr_t Field_Next           = 0x28;
    const uintptr_t Object_Flags         = 0x08;
    const uintptr_t Object_Class         = 0x10;
    const uintptr_t Object_Name          = 0x18;
    const uintptr_t World_Levels         = 0x138;      // TArray<ULevel*>
    const uintptr_t World_GameInstance   = 0x180;
    const uintptr_t Level_Actors         = 0x98;       // TArray<AActor*>
    const uintptr_t PC_Pawn              = 0x250;
    const uintptr_t Actor_Owner          = 0xE0;
    const uintptr_t Actor_InstComponents = 0x1F0;
    const uintptr_t Actor_BPComponents   = 0x200;
    const uintptr_t Part_Component       = 0x248;      // AMonsterPartActor -> its UMonsterPartComponent
    const uintptr_t PartComp_Actor       = 0x520;      // UMonsterPartComponent -> MonsterPartActor
}
static uintptr_t g_base = 0;
template <class T> static T& at(uintptr_t addr) { return *(T*)addr; }
struct FString { wchar_t* Data; int32_t Num; int32_t Max; };
struct TArrayRaw { void** Data; int32_t Num; int32_t Max; };

// ---------------------------------------------------------------------------- log, folders
static wchar_t g_dir[MAX_PATH] = L"";   // the Lantern mod's folder (this DLL is in its native\ folder)
static FILE* g_log = 0;
static void logf_(const char* fmt, ...) {
    if (!g_log) return;
    SYSTEMTIME t; GetLocalTime(&t);
    fprintf(g_log, "%02d:%02d:%02d ", t.wHour, t.wMinute, t.wSecond);
    va_list ap; va_start(ap, fmt); vfprintf(g_log, fmt, ap); va_end(ap);
    fputc('\n', g_log); fflush(g_log);
}

// ---------------------------------------------------------------------------- fenced pass (from d1147.cpp's guarded)
// The whole pass over the world runs fenced: if it reads a bad pointer, the exception handler puts the game's thread
// back here and that pass is dropped (the game carries on). One fence at a time, on the game's thread only.
static DWORD g_gameThread = 0;
static CONTEXT g_guardCtx;
static volatile LONG g_guardOn = 0, g_guardHit = 0, g_faults = 0;
__attribute__((noinline)) static bool guarded(void (*fn)(void*), void* arg) {
    g_guardHit = 0;
    RtlCaptureContext(&g_guardCtx);
    if (g_guardHit) { g_guardOn = 0; return false; }   // arrived here from the exception handler
    g_guardOn = 1; fn(arg); g_guardOn = 0;
    return true;
}
static LONG CALLBACK on_exception(EXCEPTION_POINTERS* ep) {
    if (ep->ExceptionRecord->ExceptionCode != 0xC0000005 || !g_guardOn || GetCurrentThreadId() != g_gameThread) return EXCEPTION_CONTINUE_SEARCH;
    uintptr_t at_ = (uintptr_t)ep->ExceptionRecord->ExceptionAddress;
    if (InterlockedIncrement(&g_faults) <= 20) logf_("bad read at %s+0x%llX during a pass: that pass is dropped", at_ >= g_base && at_ < g_base + 0x8000000 ? "exe" : "?", (unsigned long long)(at_ - g_base));
    g_guardOn = 0; g_guardHit = 1;
    *ep->ContextRecord = g_guardCtx;
    return EXCEPTION_CONTINUE_EXECUTION;
}

// ---------------------------------------------------------------------------- engine objects (from d1147.cpp)
static void name_w(void* obj, wchar_t* out, int n) {        // allocates a small string the engine keeps: call rarely
    FString s = { 0, 0, 0 };
    ((void (*)(void*, FString*))(g_base + A::AppendString))((void*)((uintptr_t)obj + A::Object_Name), &s);
    int i = 0; for (; s.Data && i < n - 1 && i < s.Num && s.Data[i]; i++) out[i] = s.Data[i]; out[i] = 0;
}
static void fname_w(uint64_t fname, wchar_t* out, int n) {
    FString s = { 0, 0, 0 };
    ((void (*)(void*, FString*))(g_base + A::AppendString))(&fname, &s);
    int i = 0; for (; s.Data && i < n - 1 && i < s.Num && s.Data[i]; i++) out[i] = s.Data[i]; out[i] = 0;
}
static bool name_is(void* obj, const wchar_t* want) { wchar_t b[96]; name_w(obj, b, 96); return wcscmp(b, want) == 0; }
static bool class_chain_has(void* cls, const wchar_t* want) {
    for (int d = 0; cls && d < 40; d++, cls = at<void*>((uintptr_t)cls + A::Struct_Super)) if (name_is(cls, want)) return true;
    return false;
}
static void* find_function(void* cls, const wchar_t* name) {
    for (int depth = 0; cls && depth < 32; depth++, cls = at<void*>((uintptr_t)cls + A::Struct_Super))
        for (void* f = at<void*>((uintptr_t)cls + A::Struct_Children); f; f = at<void*>((uintptr_t)f + A::Field_Next))
            if (name_is(f, name)) return f;
    return 0;
}
// per class, cached: kind (1 behemoth, 2 monster part, 3 other) and its name
struct ClsInfo { void* cls; uint8_t kind; wchar_t name[96]; };
static ClsInfo g_cls[2048]; static void* g_clsWorld = 0;
static ClsInfo* cls_info(void* cls) {
    uintptr_t h = ((uintptr_t)cls >> 4) & 2047;
    for (int i = 0; i < 2048; i++) {
        ClsInfo& k = g_cls[(h + i) & 2047];
        if (k.cls == cls) return &k;
        if (!k.cls) {
            k.cls = cls;
            k.kind = class_chain_has(cls, L"ArchonBehemoth") ? 1 : class_chain_has(cls, L"MonsterPartActor") ? 2 : 3;
            k.name[0] = 0;
            if (k.kind == 1) name_w(cls, k.name, 96);
            return &k;
        }
    }
    return 0;
}
static void* fn_cached(void* obj, const wchar_t* name, void** cache) {
    if (!*cache) *cache = find_function(at<void*>((uintptr_t)obj + A::Object_Class), name);
    return *cache;
}
static bool pe(void* obj, void* fn, uint8_t* parms) {
    if (!fn) return false; memset(parms, 0, 32);
    ((void (*)(void*, void*, void*))(g_base + A::ProcessEvent))(obj, fn, parms);
    return true;
}
static bool call_float(void* obj, void* fn, float* out) { uint8_t p[32]; if (!pe(obj, fn, p)) return false; *out = *(float*)p; return true; }
static void* g_fBehCur = 0, *g_fBehMax = 0, *g_fBehName = 0, *g_fPartCur = 0, *g_fPartMax = 0, *g_fLoc = 0;
static bool actor_loc(void* a, float* xyz) { uint8_t p[32]; if (!pe(a, fn_cached(a, L"K2_GetActorLocation", &g_fLoc), p)) return false; memcpy(xyz, p, 12); return true; }
// "LeftLeg" -> "Left leg", "head_part" -> "Head" (the Boss Health Bar's and the Lua mod's tidying)
static void pretty_part(const wchar_t* in, wchar_t* out, int n) {
    wchar_t t[64]; int k = 0;
    for (int i = 0; in[i] && k < 62; i++) t[k++] = in[i]; t[k] = 0;
    const wchar_t* cut[] = { L"PartComponent", L"_part", L"Part", L"Component" };
    for (auto c : cut) { size_t lc = wcslen(c), lt = wcslen(t); if (lt > lc && _wcsicmp(t + lt - lc, c) == 0) t[lt - lc] = 0; }
    int o = 0;
    for (int i = 0; t[i] && o < n - 2; i++) {
        wchar_t ch = t[i];
        if (ch == L'_') { if (o && out[o - 1] != L' ') out[o++] = L' '; continue; }
        if (ch >= L'0' && ch <= L'9') continue;
        if (i && iswupper(ch) && o && out[o - 1] != L' ' && !iswupper(t[i - 1])) { out[o++] = L' '; ch = towlower(ch); }
        else if (o && out[o - 1] == L' ') ch = towlower(ch);
        else if (o) ch = towlower(ch);
        out[o++] = ch;
    }
    while (o && out[o - 1] == L' ') o--;
    out[o] = 0; if (out[0]) out[0] = towupper(out[0]);
    if (!out[0]) wcsncpy(out, L"Part", n);
}

// ---------------------------------------------------------------------------- one pass over the world
const int MAXP = 24;
struct Part { void* comp; wchar_t name[48]; float cur, max; };
struct Pass { void* world; bool show, game; void* best; wchar_t cls[96]; float cur, max, loc[3]; int np; Part parts[MAXP]; };
// names cost an engine string each, so they are kept: the behemoth's row name and its parts' names, per behemoth
static void* g_namesFor = 0; static wchar_t g_row[64] = L""; static void* g_compOf[MAXP]; static wchar_t g_compName[MAXP][48];
static void* g_partCompClass = 0;
// 3.9.28: each behemoth's health at the last pass and when it last lost some. The card stays on the behemoth being
// hit: two hurt behemoths side by side made it jump between them every few seconds (27 Oct, Drask + Shrowd)
struct Seen { void* beh; float cur; ULONGLONG dropAt; };
static Seen g_seen[16]; static int g_nseen = 0;
static void* g_target = 0;   // the behemoth on the card (the game's thread only)
const ULONGLONG RECENT_MS = 6000;
static void collect(void* arg) {
    Pass& s = *(Pass*)arg;
    void* world = s.world;
    // a new world (another island, town): every kept class and function pointer is dropped (a blueprint class of the
    // last island can be freed with it)
    if (world != g_clsWorld) {
        memset(g_cls, 0, sizeof(g_cls)); g_clsWorld = world; g_namesFor = 0; g_partCompClass = 0; g_nseen = 0; g_target = 0;
        g_fBehCur = g_fBehMax = g_fBehName = g_fPartCur = g_fPartMax = g_fLoc = 0;
    }
    void* gi = at<void*>((uintptr_t)world + A::World_GameInstance);
    TArrayRaw* lp = gi ? &at<TArrayRaw>((uintptr_t)gi + 0x38) : 0;
    void* pc = (lp && lp->Data && lp->Num > 0 && lp->Data[0]) ? at<void*>((uintptr_t)lp->Data[0] + 0x30) : 0;
    s.game = pc != 0;
    if (!pc) return;   // no local player: a hunt server copy
    void* pawn = at<void*>((uintptr_t)pc + A::PC_Pawn);
    float me[3] = { 0, 0, 0 }; bool haveMe = pawn && actor_loc(pawn, me);
    void* beh[16]; int nb = 0; void* parts[96]; int np = 0;
    TArrayRaw& levels = at<TArrayRaw>((uintptr_t)world + A::World_Levels);
    for (int li = 0; levels.Data && li < levels.Num && li < 512; li++) {
        void* level = levels.Data[li]; if (!level) continue;
        TArrayRaw& actors = at<TArrayRaw>((uintptr_t)level + A::Level_Actors);
        for (int ai = 0; actors.Data && ai < actors.Num; ai++) {
            void* a = actors.Data[ai]; if (!a) continue;
            if (at<uint32_t>((uintptr_t)a + A::Object_Flags) & 0x60000000) continue;   // pending kill / unreachable
            ClsInfo* ci = cls_info(at<void*>((uintptr_t)a + A::Object_Class)); if (!ci) continue;
            if (ci->kind == 1 && nb < 16) beh[nb++] = a; else if (ci->kind == 2 && np < 96) parts[np++] = a;
        }
    }
    // a behemoth losing health (last 6 s) first, then a hurt one, then an untouched one within 90 m (the Boss Health
    // Bar's rule); within each, the nearest. The card's own behemoth counts as 3x nearer, so it does not flicker.
    // (Before, a float score 1e20 - 1e12 lost the "hurt" bonus when your position could not be read.)
    ULONGLONG now = GetTickCount64();
    Seen seen[16]; int ns = 0;
    int bestTier = -1; double bestD2 = 0;
    for (int i = 0; i < nb; i++) {
        float cur = 0, mx = 0;
        if (!call_float(beh[i], fn_cached(beh[i], L"GetMaxHealth", &g_fBehMax), &mx) || mx <= 0) continue;
        call_float(beh[i], fn_cached(beh[i], L"GetCurrentHealth", &g_fBehCur), &cur);
        if (cur <= 0) continue;
        ULONGLONG dropAt = 0;
        for (int k = 0; k < g_nseen; k++) if (g_seen[k].beh == beh[i]) { dropAt = cur < g_seen[k].cur ? now : g_seen[k].dropAt; break; }
        if (ns < 16) seen[ns++] = { beh[i], cur, dropAt };
        double d2 = 1e20, p3[3] = { 0, 0, 0 }; float p[3] = { 0, 0, 0 };
        if (haveMe && actor_loc(beh[i], p)) { for (int k = 0; k < 3; k++) p3[k] = (double)p[k] - me[k]; d2 = p3[0]*p3[0] + p3[1]*p3[1] + p3[2]*p3[2]; }
        bool hurt = cur < mx, recent = dropAt && now - dropAt < RECENT_MS, mine = beh[i] == g_target;
        if (!hurt && d2 > 9000.0 * 9000.0) continue;
        int tier = recent ? 2 : hurt ? 1 : 0;
        if (mine) d2 /= 9;
        if (tier > bestTier || (tier == bestTier && d2 < bestD2)) { bestTier = tier; bestD2 = d2; s.best = beh[i]; s.cur = cur; s.max = mx; memcpy(s.loc, p, 12); }
    }
    memcpy(g_seen, seen, sizeof(Seen) * ns); g_nseen = ns;
    g_target = s.best;
    if (!s.best) return;
    void* best = s.best;
    s.show = true;
    ClsInfo* bc = cls_info(at<void*>((uintptr_t)best + A::Object_Class));
    wcsncpy(s.cls, bc ? bc->name : L"", 95); s.cls[95] = 0;
    bool fresh = best != g_namesFor;
    if (fresh) {
        g_namesFor = best; g_row[0] = 0; memset(g_compOf, 0, sizeof(g_compOf));
        uint8_t p[32];
        if (pe(best, fn_cached(best, L"GetBehemothFullName", &g_fBehName), p)) fname_w(*(uint64_t*)p, g_row, 64);
    }
    // its part actors, reached only through its own MonsterPartComponents (d1147.cpp DF-BOSSBAR-SAFE: reading 0x520 of
    // another kind of component ran past it and crashed the game)
    void* linked[96]; int nl = 0;
    for (int arr = 0; arr < 2; arr++) {
        TArrayRaw& cs = at<TArrayRaw>((uintptr_t)best + (arr ? A::Actor_BPComponents : A::Actor_InstComponents));
        for (int ci = 0; cs.Data && ci < cs.Num && ci < 256; ci++) {
            void* comp = cs.Data[ci]; if (!comp) continue;
            void* cc = at<void*>((uintptr_t)comp + A::Object_Class);
            if (cc != g_partCompClass) { if (!class_chain_has(cc, L"MonsterPartComponent")) continue; g_partCompClass = cc; }
            void* pa = at<void*>((uintptr_t)comp + A::PartComp_Actor);
            if (!pa) continue;
            if (nl < 96) linked[nl++] = pa;
            bool dup = false; for (int k = 0; k < np; k++) if (parts[k] == pa) { dup = true; break; }
            if (!dup && np < 96) parts[np++] = pa;
        }
    }
    for (int i = 0; i < np && s.np < MAXP; i++) {
        if (at<void*>((uintptr_t)parts[i] + A::Actor_Owner) != best) {
            bool mine = false; for (int k = 0; k < nl && !mine; k++) if (linked[k] == parts[i]) mine = true;
            if (!mine) continue;
        }
        float cur = 0, mx = 0;
        if (!call_float(parts[i], fn_cached(parts[i], L"GetMaxHealth", &g_fPartMax), &mx) || mx <= 0) continue;
        if (mx > s.max) continue;   // "Body": millions of health, not a part you break
        call_float(parts[i], fn_cached(parts[i], L"GetHealth", &g_fPartCur), &cur);
        Part& bp = s.parts[s.np++];
        bp.comp = at<void*>((uintptr_t)parts[i] + A::Part_Component);
        bp.cur = cur < 0 ? 0 : cur; bp.max = mx; bp.name[0] = 0;
        int slot = -1;
        for (int k = 0; k < MAXP; k++) if (g_compOf[k] == bp.comp) { slot = k; break; }
        if (slot < 0) for (int k = 0; k < MAXP; k++) if (!g_compOf[k]) { slot = k; break; }
        if (slot >= 0 && g_compOf[slot] != bp.comp) {
            wchar_t raw[64] = L""; if (bp.comp) name_w(bp.comp, raw, 64);
            pretty_part(raw, g_compName[slot], 48); g_compOf[slot] = bp.comp;
        }
        if (slot >= 0) wcscpy(bp.name, g_compName[slot]); else wcscpy(bp.name, L"Part");
    }
}

// ---------------------------------------------------------------------------- what this fight looks like over time
// Broken parts: a part that reaches 0, or that the game refills (it refills a broken part at once, to 100% or 87-93%:
// a rise of half its health or more, ending at 70%+, with its max unchanged), stays BROKEN until the behemoth is gone.
// Breaks are counted. A refill from a 0 reading is not a second break (the 0 was counted; bullseye quills that read 0
// at the start and grew back at once were two false breaks). A changed max is the game rescaling, not a refill.
// 3.9.28: kept per behemoth (the last 4), so switching the card to another behemoth and back keeps its BROKEN marks.
struct PartState { wchar_t name[48]; float last, max; int breaks; bool broken; };
struct Fight { void* beh; PartState ps[MAXP]; int nps; long long at; int hits; float lastCur; ULONGLONG used; };
static Fight g_fights[4]; static Fight* g_fight = 0; static void* g_fightWorld = 0;
static CRITICAL_SECTION g_jsonLock; static char g_json[8192] = "null"; static volatile LONG g_jsonSeq = 0;
static volatile LONG g_on = 0;
static int g_noteGame = 0;
static void jstr(char*& o, char* end, const wchar_t* w) {
    *o++ = '"';
    for (int i = 0; w[i] && o < end - 8; i++) { wchar_t c = w[i]; if (c == L'"' || c == L'\\' || c < 32 || c > 126) continue; *o++ = (char)c; }
    *o++ = '"';
}
static void publish(Pass& s) {
    char buf[8192]; char* o = buf; char* end = buf + sizeof(buf) - 64;
    if (!s.show) { strcpy(buf, "null"); }
    else {
        if (s.world != g_fightWorld) { memset(g_fights, 0, sizeof(g_fights)); g_fightWorld = s.world; }
        // a behemoth that is dead or gone is forgotten (a new one can get its address)
        for (auto& k : g_fights) {
            bool alive = false; for (int j = 0; j < g_nseen && !alive; j++) alive = g_seen[j].beh == k.beh;
            if (k.beh && !alive) memset(&k, 0, sizeof(k));
        }
        g_fight = 0;
        for (auto& k : g_fights) if (k.beh == s.best) { g_fight = &k; break; }
        if (!g_fight) {
            Fight* f = &g_fights[0];
            for (auto& k : g_fights) if (k.used < f->used) f = &k;
            memset(f, 0, sizeof(*f)); f->beh = s.best; f->lastCur = -1;
            logf_("tracking %ls ('%ls') %.0f/%.0f with %d part(s)", s.cls, g_row, s.cur, s.max, s.np);
            g_fight = f;
        }
        Fight& F = *g_fight;
        F.used = GetTickCount64();
        if (F.lastCur >= 0 && s.cur < F.lastCur - 0.01f) { F.at = (long long)time(0); F.hits++; }
        F.lastCur = s.cur;
        o += snprintf(o, end - o, "{\"key\":\"%p\",\"cls\":", s.best); jstr(o, end, s.cls);
        o += snprintf(o, end - o, ",\"cur\":%.0f,\"max\":%.0f,\"at\":%lld,\"n\":%d,\"dead\":false,\"parts\":[", s.cur, s.max, F.at, F.hits);
        for (int i = 0; i < s.np; i++) {
            Part& p = s.parts[i];
            PartState* st = 0;
            for (int k = 0; k < F.nps; k++) if (wcscmp(F.ps[k].name, p.name) == 0) { st = &F.ps[k]; break; }
            if (!st && F.nps < MAXP) { st = &F.ps[F.nps++]; wcscpy(st->name, p.name); st->last = p.cur; st->max = p.max; st->breaks = 0; st->broken = false; }
            if (st) {
                bool zero = st->last > 0 && p.cur <= 0;
                bool refill = st->last > 0 && p.max == st->max && p.cur - st->last >= p.max * 0.5f && p.cur >= p.max * 0.7f;
                if (zero || refill) { st->breaks++; if (!st->broken) logf_("   %ls broke (%.0f -> %.0f of %.0f)", p.name, st->last, p.cur, p.max); st->broken = true; }
                st->last = p.cur; st->max = p.max;
            }
            bool broken = st && st->broken;
            if (i) *o++ = ',';
            *o++ = '['; jstr(o, end, p.name);
            o += snprintf(o, end - o, ",%.0f,%.0f,%d,%d]", broken ? 0.0f : p.cur, p.max, st ? st->breaks : 0, broken ? 1 : 0);
        }
        o += snprintf(o, end - o, "],\"nm\":"); jstr(o, end, g_row);
        o += snprintf(o, end - o, ",\"loc\":[%.0f,%.0f,%.0f]}", s.loc[0], s.loc[1], s.loc[2]);
        *o = 0;
    }
    EnterCriticalSection(&g_jsonLock);
    if (strcmp(buf, g_json) != 0) { strcpy(g_json, buf); InterlockedIncrement(&g_jsonSeq); }
    LeaveCriticalSection(&g_jsonLock);
}

// ---------------------------------------------------------------------------- the engine tick (the game's thread)
static void (*orig_Tick)(void*, float, bool) = 0;
static long g_ticks = 0;
static void hook_Tick(void* engine, float dt, bool idle) {
    orig_Tick(engine, dt, idle);
    // every 5th frame (12 a second at 60 fps; DF's bar reads every 15th): the card follows hits closely
    if (!g_on || ++g_ticks % 5) return;
    g_gameThread = GetCurrentThreadId();
    void* world = at<void*>(g_base + A::GWorld);
    if (!world) return;
    static Pass s; memset(&s, 0, sizeof(s)); s.world = world;
    if (!guarded(collect, &s)) { g_namesFor = 0; return; }   // a bad read: this pass is dropped, names looked up again
    if (!s.game) return;
    if (!g_noteGame++) logf_("your game: tracking on");
    publish(s);
}

// ---------------------------------------------------------------------------- files (its own thread, no game objects)
static DWORD WINAPI files_thread(void*) {
    wchar_t toggles[MAX_PATH + 32], track[MAX_PATH + 64], tmp[MAX_PATH + 72];
    swprintf(toggles, MAX_PATH + 32, L"%ls\\trainer-toggles.json", g_dir);
    // one name: only your own game writes it (the Lua mod reads it to know the tracker is running)
    swprintf(track, MAX_PATH + 64, L"%ls\\track\\native.json", g_dir);
    swprintf(tmp, MAX_PATH + 72, L"%ls.tmp", track);
    LONG lastSeq = -1; ULONGLONG lastWrite = 0, lastRead = 0; bool wrote = false;
    for (;;) {
        Sleep(50);
        ULONGLONG now = GetTickCount64();
        if (now - lastRead >= 500) {
            lastRead = now;
            char t[2048] = ""; FILE* f = _wfopen(toggles, L"rb");
            if (f) { size_t n = fread(t, 1, sizeof(t) - 1, f); t[n] = 0; fclose(f); }
            LONG on = strstr(t, "\"native\":true") != 0;   // the panel sets it while Lantern's card is on
            if (on != g_on) { g_on = on; logf_("toggles: native %s", on ? "on" : "off"); }
        }
        if (!g_on || !g_noteGame) {
            if (wrote) { DeleteFileW(track); wrote = false; }
            continue;
        }
        LONG seq = g_jsonSeq;
        if (seq == lastSeq && now - lastWrite < 1000) continue;
        char body[8192]; EnterCriticalSection(&g_jsonLock); strcpy(body, g_json); LeaveCriticalSection(&g_jsonLock);
        FILE* f = _wfopen(tmp, L"wb");
        if (!f) continue;
        fprintf(f, "{\"role\":\"game\",\"src\":\"native\",\"time\":%lld,\"b\":%s}", (long long)time(0), body);
        fclose(f);
        // fails while a reader holds the file open (the Lua mod's io.open shares no delete): try again in 50 ms
        if (!MoveFileExW(tmp, track, MOVEFILE_REPLACE_EXISTING)) continue;
        lastSeq = seq; lastWrite = now; wrote = true;
    }
}

// ---------------------------------------------------------------------------- start
static bool readable(uintptr_t p, size_t n) {   // committed, readable memory (another exe may not reach that far)
    MEMORY_BASIC_INFORMATION mi;
    if (!VirtualQuery((void*)p, &mi, sizeof(mi)) || mi.State != MEM_COMMIT || (mi.Protect & (PAGE_NOACCESS | PAGE_GUARD))) return false;
    return p + n <= (uintptr_t)mi.BaseAddress + mi.RegionSize;
}
static DWORD WINAPI init_thread(void*) {
    wchar_t lp[MAX_PATH + 64]; SYSTEMTIME t; GetLocalTime(&t);
    swprintf(lp, MAX_PATH + 64, L"%ls\\logs\\native-%04d%02d%02d-%02d%02d%02d-%lu.log", g_dir, t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond, GetCurrentProcessId());
    g_log = _wfopen(lp, L"w");
    g_base = (uintptr_t)GetModuleHandleA(0);
    logf_("Lantern native tracker (3.9.28) loaded, exe base %p", (void*)g_base);
    static const uint8_t listenCall[5] = { 0xE8, 0x0B, 0x79, 0x77, 0xFC };
    if (!readable(g_base + A::LoadMapListenCall, 5) || !readable(g_base + A::GameEngineTick, 4) || !readable(g_base + A::GWorld, 8) ||
        memcmp((void*)(g_base + A::LoadMapListenCall), listenCall, 5) != 0) { logf_("not the player's 1.14.7 game (a hunt server copy, which DF patches there, or another build): off"); return 0; }
    static const uint8_t tickStart[4] = { 0x48, 0x8B, 0xC4, 0x48 };
    if (memcmp((void*)(g_base + A::GameEngineTick), tickStart, 4) != 0) { logf_("the engine tick is already hooked (Dauntless Forever's Boss Health Bar is on?): off"); return 0; }
    InitializeCriticalSection(&g_jsonLock);
    AddVectoredExceptionHandler(1, on_exception);
    MH_STATUS s = MH_Initialize();
    if (s != MH_OK && s != MH_ERROR_ALREADY_INITIALIZED) { logf_("MinHook failed: off"); return 0; }
    s = MH_CreateHook((void*)(g_base + A::GameEngineTick), (void*)hook_Tick, (void**)&orig_Tick);
    if (s == MH_OK) s = MH_EnableHook((void*)(g_base + A::GameEngineTick));
    logf_("engine tick hook %s", s == MH_OK ? "ok" : "FAILED");
    if (s != MH_OK) return 0;
    HANDLE h = CreateThread(0, 0, files_thread, 0, 0, 0); if (h) CloseHandle(h);
    return 0;
}
BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID) {
    if (reason != DLL_PROCESS_ATTACH) return TRUE;
    DisableThreadLibraryCalls(inst);
    wchar_t p[MAX_PATH]; DWORD n = GetModuleFileNameW(inst, p, MAX_PATH);
    if (!n || n >= MAX_PATH) return TRUE;
    for (int up = 0; up < 2; up++) { wchar_t* sl = wcsrchr(p, L'\\'); if (sl) *sl = 0; }   // <mod>\native\x.dll -> <mod>
    wcscpy(g_dir, p);
    HANDLE h = CreateThread(0, 0, init_thread, 0, 0, 0); if (h) CloseHandle(h);
    return TRUE;
}
