-- SPDX-License-Identifier: AGPL-3.0-only
-- Lantern Client: behemoth tracking for the Lantern overlay, for Dauntless 1.14.7 (Dauntless Forever / UE4SS 3.0.1),
-- and the experimental instant inventory refresh. (The quest tracker was removed in 7.3.)
--
-- The panel writes trainer-toggles.json into this mod's folder; this script reads it twice a second. The folder is
-- shared by your game and every hidden server copy (they all run the same exe), so the overlay can read behemoth
-- health on the hunt servers, which own it ("Also run mods on my servers" must be on).
--
-- Kept light on purpose: with the overlay and instant refresh off, it only reads that small file.
-- Only property reads are used (7.0 removed the damage multiplier: the hunt server rewrites a behemoth's health from
-- its ability system on every hit, so a written health never stuck). Logged as [DFTrainer] in UE4SS.log.

local MOD_VERSION  = "7.8"   -- 7.5's tracking (7.6's search-free test removed in 7.7); 7.8 loads the owner's native tracker
local TICK_MS      = 150    -- how often the mod's loop runs
local RESCAN_EVERY = 2.0    -- seconds between searches for players (instant refresh)
local READ_EVERY   = 0.5    -- seconds between reads of the toggles file
local STATUS_EVERY = 2.0    -- seconds between status heartbeats for the panel
local PC_CLASSES   = { "player_controller_bp_C", "ArchonPlayerController", "PlayerController" }

---------------------------------------------------------------- helpers
-- UE4SS.log is rewritten by every copy of the game that starts (each hunt server too), so the mod also keeps its own
-- log per process in logs\<date>-<process>.log in its folder, which nothing overwrites (the panel keeps a week of them)
local LogFile = nil
local function log(m)
    print("[DFTrainer] " .. tostring(m) .. "\n")
    if LogFile then
        local f = io.open(LogFile, "a")
        if f then f:write(os.date("%H:%M:%S ") .. tostring(m) .. "\n") f:close() end
    end
end
local logged = {}
local function logOnce(k, m) if not logged[k] then logged[k] = true log(m) end end

-- o[k] and o:m() for pcall without a new closure each call
local function getField(o, k) return o[k] end
local function callM(o, m) return o[m](o) end
local function valid(o)
    if not o then return false end
    local ok, v = pcall(callM, o, "IsValid")
    return ok and v and true or false
end
local function nameOf(o)
    local ok, n = pcall(function() return o:GetFullName() end)
    return ok and n or nil
end
local function pathOf(o)
    local full = nameOf(o)
    return full and full:match("^%S+%s+(.+)$")
end
-- A game object kept from an earlier pass may have been freed by the game since (its garbage collector runs between
-- our passes, and a part actor is replaced in the middle of a fight). Touching a freed one, even asking IsValid,
-- reads freed memory. So kept objects are kept as their path and found again through the game's own object table at
-- the start of each pass (fresh), and nothing is ever called on an old reference.
local function fresh(path)
    if not path then return nil end
    local ok, o = pcall(StaticFindObject, path)
    if not ok or o == nil or type(o) == "number" or type(o) == "string" or type(o) == "boolean" then return nil end
    local okV, v = pcall(callM, o, "IsValid")
    return (okV and v) and o or nil
end
local function readNum(o, prop)
    local ok, v = pcall(getField, o, prop)
    if ok and type(v) == "number" then return v end
    return nil
end
-- a number JSON can carry: NaN and +-inf (which %.0f writes as "nan" / "inf", breaking the file) become 0
local function fin(v)
    if type(v) ~= "number" or v ~= v or v > 1e15 or v < -1e15 then return 0 end
    return v
end
local function under(objPath, ownerPath)
    return objPath and ownerPath and objPath:sub(1, #ownerPath + 1) == ownerPath .. "."
end
-- 7.3: every game object is touched on the game's own thread only (its hit, break and quest events), never on the
-- mod's timer thread, which now only reads and writes this mod's files. Four crashes on 25-26 Oct (UE4SS v3.0.1 dumps,
-- symbolized) were all on the timer thread, inside UE4SS's Lua object code: IsValid on an object the game had freed
-- (UObjectBase::GetInternalIndex), and property reads on freed objects (UStruct::FindProperty, a struct read). The game
-- frees objects on its own thread, so reading them from another thread can find freed memory at any moment.
-- Object searches (FindAllOf) go through every object the game has, so they are kept rare (6.6: UE4SS's object
-- cache, which made them cheap, crashed the game while it loaded many items at once; the panel turns it off).
local InGT = false            -- true while a game-thread event runs
local searchLogs = 0   -- the first searches are timed in the log (os.clock is wall time in UE4SS on Windows)
-- 7.5: each search costs the game a pause (logged 26 Oct: 32-37 ms in your game, 16-22 ms on a hunt server, with the
-- object cache off), so they are counted, and once a minute the log says what the overlay cost the game's thread
local Cost = { n = 0, ms = 0, worst = 0, at = nil }
local function search(cls)
    local t0 = os.clock()
    local ok, list = pcall(FindAllOf, cls)
    Cost.n, Cost.ms = Cost.n + 1, Cost.ms + (os.clock() - t0) * 1000
    if searchLogs < 12 then
        searchLogs = searchLogs + 1
        log(string.format("search %s: %d found in %.1f ms", cls, (ok and type(list) == "table") and #list or 0, (os.clock() - t0) * 1000))
    end
    return ok and list or {}
end
PendingRefresh = nil           -- an instant refresh waiting for the game's thread
local function onGameThread(fn, ...)
    local was = InGT
    InGT = true
    local now = os.clock()
    Cost.passN = Cost.n
    if onGameThreadRole then pcall(onGameThreadRole, now) end
    if PendingRefresh and runPendingRefresh then pcall(runPendingRefresh) end
    local ok, err = pcall(fn, ...)
    InGT = was
    local took = (os.clock() - now) * 1000
    if took > Cost.worst then Cost.worst = took end
    return ok, err
end
local function findAll(classes)
    local out, seen = {}, {}
    for _, cls in ipairs(classes) do
        local ok, list = true, search(cls)
        for _, o in ipairs(ok and list or {}) do
            local n = nameOf(o)
            if n and not seen[n] and not n:find("Default__", 1, true) and valid(o) then
                seen[n] = true
                out[#out + 1] = o
            end
        end
    end
    return out
end
local function fileExists(p)
    local f = io.open(p, "r")
    if f then f:close() return true end
    return false
end

---------------------------------------------------------------- this mod's folder (shared by game and servers)
local function modFolder()
    local function parentOfScripts(p)
        if not p then return nil end
        p = p:gsub("^@", "")
        local dir = p:match("^(.*)[/\\][Ss][Cc][Rr][Ii][Pp][Tt][Ss][/\\][^/\\]*$")
        if dir and dir:match("^%a:[/\\]") then return dir end
        return nil
    end
    local ok, info = pcall(function() return debug.getinfo(1, "S") end)
    if ok and info then
        local d = parentOfScripts(info.source)
        if d and fileExists(d .. "/df-mod.json") then return d end
    end
    for entry in tostring(package.path):gmatch("[^;]+") do
        local dir = entry:match("^(.*)[/\\][Ss][Cc][Rr][Ii][Pp][Tt][Ss][/\\]%?%.lua$")
        if dir and fileExists(dir .. "/dftrainer.marker") then return dir end
    end
    return nil
end

local Base = modFolder()
local TogglesFile = Base and (Base .. "/trainer-toggles.json")
local ProcId = (tostring({}):match("0x(%x+)") or tostring(os.time())):sub(-8)
local StatusFile = Base and (Base .. "/status/" .. ProcId .. ".json")
if Base then LogFile = Base .. "/logs/" .. os.date("%Y%m%d-%H%M%S") .. "-" .. ProcId .. ".log" end
if Base then log("mod folder: " .. Base .. " (process " .. ProcId .. ")") else log("could not find the mod folder; the panel cannot reach this process") end

---------------------------------------------------------------- toggles (flat JSON written by the panel)
local T = { refresh = false, refreshFn = "", locked = false, track = false }
local togglesText = ""

local function parseToggles(s)
    local function flag(k) return s:find('"' .. k .. '"%s*:%s*true') ~= nil end
    T.refresh = flag("refresh")
    T.refreshFn = s:match('"refreshFn"%s*:%s*"([%w_]*)"') or ""
    T.locked = flag("locked")   -- not the owner's panel: no refresh
    if T.locked then T.refresh = false end
    T.track = flag("track")     -- the behemoth overlay is on (anyone's panel)
    T.native = flag("native") and not T.locked   -- 7.8: the owner's native tracker (native\lantern_native.dll)
end

-- 7.8: the native tracker is a DLL next to this script's folder. Loaded once, the first time it is asked for; it reads
-- the toggles itself, walks the game's actor lists from the engine's own tick (no searches) and writes
-- track\native-<process>.json. Loading it again does nothing (Windows keeps one copy).
local NativeLoaded = false
local function loadNative()
    if NativeLoaded or not Base then return end
    NativeLoaded = true
    local path = (Base .. "/native/lantern_native.dll"):gsub("/", "\\")
    if not fileExists(path) then log("native tracker: " .. path .. " not found") return end
    local ok, r, err = pcall(package.loadlib, path, "*")
    log("native tracker: " .. ((ok and r) and "loaded" or ("could not load (" .. tostring(ok and err or r) .. ")")))
end

local function readToggles()
    if not TogglesFile then return end
    local f = io.open(TogglesFile, "r")
    if not f then return end
    local s = f:read("*a") or ""
    f:close()
    if s ~= togglesText and s:find("}", 1, true) then
        togglesText = s
        parseToggles(s)
        log(string.format("toggles: refresh=%s track=%s native=%s", tostring(T.refresh), tostring(T.track), tostring(T.native)))
        if T.native then loadNative() end
    end
end

---------------------------------------------------------------- what is in this process
local S = { role = "server", owners = {} }
local lastRescan = -100

-- your game is the only copy with a local player (your screen and keyboard); server copies only have remote
-- controllers. IsLocalController alone does not answer in every copy (3.3.x took your game for a server and let it
-- look for parts), so the local player objects decide too, as in the first versions of this mod.
local function isLocal(pc)
    -- IsLocalController is a game function: asked only on the game's thread (6.8; the timer thread reads properties)
    if InGT then
        local ok, res = pcall(function() return pc:IsLocalController() end)
        if ok and res == true then return true end
    end
    local okP, pl = pcall(function() return pc.Player end)
    if not (okP and valid(pl)) then return false end
    local n = (nameOf(pl) or ""):lower()
    return n:find("localplayer", 1, true) ~= nil or n:find("local_player", 1, true) ~= nil
end
local function hasLocalPlayer()
    for _, cls in ipairs({ "ArchonLocalPlayer", "LocalPlayer" }) do
        local ok, list = true, search(cls)
        for _, lp in ipairs(ok and list or {}) do
            local n = nameOf(lp) or ""
            if valid(lp) and not n:find("Default__", 1, true) then return true end
        end
    end
    return false
end

-- behemoths and their health sets; players only when instant refresh needs their inventories
local function rescan(now)
    if not InGT then return end   -- 7.3: searches and reads on the game's thread only
    lastRescan = now
    local isGame, owners = false, {}
    local owners0 = findAll(PC_CLASSES)
    for _, pc in ipairs(owners0) do
        if isLocal(pc) then isGame, S.localPCPath = true, pathOf(pc) end   -- your controller: where you are (the overlay)
        if T.refresh then
            local okP, pawn = pcall(function() return pc.Pawn end)
            if okP and valid(pawn) then
                local okS, ps = pcall(function() return pc.PlayerState end)
                owners[#owners + 1] = { path = pathOf(pawn), psPath = (okS and valid(ps)) and pathOf(ps) or nil, pcPath = pathOf(pc) }
            end
        end
    end
    if not isGame and S.role ~= "game" then isGame = hasLocalPlayer() end
    -- 7.5: a copy with players' controllers and none of them local, three times over 30 s, is a hunt server for good
    -- (it looked again every 10 s for its whole life before: five searches, ~90 ms, each time)
    if not isGame and #owners0 > 0 then
        S.serverSeen = (S.serverSeen or 0) + 1
        S.serverFirst = S.serverFirst or now
        if S.serverSeen >= 3 and now - S.serverFirst >= 30 and not S.serverSure then S.serverSure = true log("role: hunt server, sure (no more role checks)") end
    end
    -- once your game, always your game (a server copy never gets a local player)
    S.role = (isGame or S.role == "game") and "game" or "server"
    S.roleKnown = true
    S.owners = owners

    if S.role ~= S.lastSummary then S.lastSummary = S.role log("role: " .. S.role) end
end
-- at the start of each game-thread event: which copy of the game this is, until known to be your game (a game never
-- becomes a server; a server copy looks again every 10 s)
function onGameThreadRole(now)
    if not S.roleKnown or (S.role ~= "game" and not S.serverSure and now - lastRescan >= 10) then rescan(now) end
end

---------------------------------------------------------------- experimental: make the game load its inventory again
-- Off unless "Instant refresh" is on in the panel. When a gift lands, the panel bumps refresh-request.json; this calls
-- one parameterless, refresh-like function on the players' ArchonInventory objects. The panel watches the backend log:
-- if the game loads the inventory right after, it keeps that function (refreshFn) and only ever calls that one.
local RefreshFile = Base and (Base .. "/refresh-request.json")
local REFRESH_WORDS = { "refresh", "reload", "fetch", "requery", "resync", "request", "sync" }
local REFRESH_NEVER = { "slot", "exchange", "craft", "salvage", "remove", "delete", "clear", "reset", "equip", "debug",
    "cheat", "grant", "purchase", "spend", "consume", "add", "set", "destroy", "fusion", "cell" }
local invFns, invFnsDone, nextFn, lastReq = nil, false, 1, nil
S.called, S.calledAt = nil, 0

local function refreshScore(n)
    local l = n:lower()
    for _, bad in ipairs(REFRESH_NEVER) do if l:find(bad, 1, true) then return nil end end
    if not l:find("inventor", 1, true) and not l:find("item", 1, true) then return nil end
    for i, w in ipairs(REFRESH_WORDS) do if l:find(w, 1, true) then return i end end
    return nil
end
-- functions with no parameters (a return value is fine) whose names look like a refresh, best guess first
local function discoverInvFns(inv)
    local found = {}
    local ok, cls = pcall(function() return inv:GetClass() end)
    local depth = 0
    while ok and cls and valid(cls) and depth < 4 do
        pcall(function()
            cls:ForEachFunction(function(fn)
                local okN, n = pcall(function() return fn:GetFName():ToString() end)
                if not okN or not n then return end
                local score = refreshScore(n)
                if not score then return end
                local params = 0
                pcall(function() fn:ForEachProperty(function(p)
                    local okP, pn = pcall(function() return p:GetFName():ToString() end)
                    if not (okP and pn == "ReturnValue") then params = params + 1 end
                end) end)
                if params == 0 then found[#found + 1] = { name = n, score = score } end
            end)
        end)
        local okS, sup = pcall(function() return cls:GetSuperStruct() end)
        if not okS then break end
        cls = sup
        depth = depth + 1
    end
    table.sort(found, function(a, b) return a.score < b.score or (a.score == b.score and a.name < b.name) end)
    local names = {}
    for _, f in ipairs(found) do names[#names + 1] = f.name end
    return names
end
local function playerInventories()
    local out = {}
    local ok, list = true, search("ArchonInventory")
    for _, inv in ipairs(ok and list or {}) do
        local ip = pathOf(inv)
        if valid(inv) and ip and not ip:find("Default__", 1, true) then
            for _, ow in ipairs(S.owners or {}) do
                if under(ip, ow.path) or under(ip, ow.psPath) or under(ip, ow.pcPath) then out[#out + 1] = inv break end
            end
        end
    end
    return out
end
local function checkRefresh()
    if not RefreshFile then return end
    local f = io.open(RefreshFile, "r")
    if not f then lastReq = lastReq or 0 return end
    local n = tonumber((f:read("*a") or ""):match('"n"%s*:%s*(%d+)'))
    f:close()
    if not n then return end
    if lastReq == nil then lastReq = n return end   -- an old request from before this process started
    if n == lastReq then return end
    lastReq = n
    if not T.refresh then return end
    PendingRefresh = { n = n }   -- 7.3: everything else (finding the inventories, calling) on the game's thread
end
local function pickRefresh()
    local invs = playerInventories()
    if #invs == 0 then return nil end
    if not invFnsDone then
        invFns = discoverInvFns(invs[1])
        invFnsDone = true
        log("instant refresh candidates: " .. (#invFns > 0 and table.concat(invFns, ", ") or "none found"))
    end
    if not invFns or #invFns == 0 then return nil end
    local pick = nil
    if T.refreshFn ~= "" then
        for _, n2 in ipairs(invFns) do if n2 == T.refreshFn then pick = n2 end end
    end
    if not pick then
        pick = invFns[((nextFn - 1) % #invFns) + 1]
        nextFn = nextFn + 1
    end
    return { pick = pick, invs = invs }
end
-- on the game's thread only
function runPendingRefresh()
    if not PendingRefresh then return end
    PendingRefresh = nil
    if not S.roleKnown or (T.refresh and os.clock() - lastRescan >= RESCAN_EVERY) then rescan(os.clock()) end
    local r = pickRefresh()
    if not r then return end
    local n = 0
    for _, inv in ipairs(r.invs) do
        if valid(inv) then
            local okC, err = pcall(function() return inv[r.pick](inv) end)
            if okC then n = n + 1 else logOnce("callerr:" .. r.pick, "calling " .. r.pick .. " failed: " .. tostring(err)) end
        end
    end
    S.called, S.calledAt = r.pick, os.time()
    log("instant refresh: called " .. r.pick .. " on " .. n .. " inventory object(s)")
end

---------------------------------------------------------------- behemoth tracking (the Lantern overlay)
local function clean(s) return (tostring(s or ""):gsub('[^%w_ .,:/>-]', '')) end
-- Only while the overlay is on. Follows the behemoth you are fighting: one shows up once its health (or one of its
-- parts' health) drops, the most recently hit one is followed, a dead one stays 4 s, a gone one is dropped at once.
-- Written to track\<process>.json in this folder (10 times a second at most, while something changes); the panel
-- picks the copy that knows most (a hunt server has the part actors, your game usually has none) and feeds the overlay.
--
-- Like Dauntless Forever's Boss Health Bar (its loader, d1147.cpp), parts are the behemoth's MonsterPartComponents,
-- named by their object name ("LeftLeg" -> "Left leg"), each pointing at its part actor; but read through properties
-- (health attribute sets), since calling game functions from this Lua does not give usable results here.
local TRACK_SCAN   = 2.0     -- seconds between searches for behemoths while tracking (7.3: on the game's thread)
local TRACK_STALE  = 30.0    -- seconds without a hit before the overlay's last reading is dropped
local TRACK_PARTS  = 3.0     -- seconds between part searches for a behemoth that has none linked yet
local TRACK_REBIND = 2.0     -- seconds between part re-links once found (7.5: through each part's own component, no search)
local TRACK_PS     = 30.0    -- seconds between searches for player states (stagger damage; 5 s before 7.5)
local TRACK_SAFETY = 20.0    -- 7.5: a behemoth search at most this often when every hit is explained by a known one
local TRACK_TRIES  = 3       -- searches for the parts of a behemoth that has none, before only trying while it is hit
local TRACK_LINGER = 4.0     -- seconds a dead behemoth stays on the overlay
local TRACK_BEAT   = 1.0     -- seconds: rewrite the file this often even when nothing changed
local TRACK_MINE   = 15.0    -- seconds: a behemoth hit this recently can be the one you are fighting
local TRACK_LIST   = 6       -- a hunt server lists this many recently hit behemoths (the panel picks yours)
local TrackFile = Base and (Base .. "/track/" .. ProcId .. ".json")
local Tk = { list = {}, lastScan = -100, lastWrite = -100, lastBody = nil, n = 0, cleared = true }

local function lastName(o)
    local p = pathOf(o)
    return p and p:match("([^%.:]+)$") or nil
end
-- "LeftLegPartComponent" -> "Left leg", "head_part" -> "Head" (the same tidying as the Boss Health Bar)
local function prettyPart(raw)
    local t = tostring(raw or "")
    for _, cut in ipairs({ "PartComponent", "_part", "Part", "Component" }) do
        if #t > #cut and t:sub(-#cut):lower() == cut:lower() then t = t:sub(1, -#cut - 1) end
    end
    t = t:gsub("_C$", ""):gsub("%d", ""):gsub("_", " ")
    t = t:gsub("(%l)(%u)", "%1 %2"):gsub("%s+", " "):gsub("^%s+", ""):gsub("%s+$", "")
    if t == "" then return "Part" end
    t = t:lower()
    return (t:gsub("^%l", string.upper))
end

-- A part's health is an ArchonHealthAttributeSet under its part actor (like a behemoth's), and a MonsterPartComponent
-- points at its part actor through its MonsterPartActor property (both seen in 1.14.7's hunt servers). Only those
-- named properties are read: walking every property of a game object and reading each one can crash the game (a
-- 3.3.0 test crashed the player's game that way, where part actors do not exist and the walk never stopped).
local PART_LINKS = { "MonsterPartActor", "PartActor" }
local function healthSetUnder(sets, path)
    local best, bestMax = nil, 0
    for _, st in ipairs(sets) do
        if under(pathOf(st), path) then
            local m = readNum(st, "MaxHealth") or 0
            if m > bestMax then best, bestMax = st, m end
        end
    end
    return best
end
local function partSet(actor, sets)
    local ap = pathOf(actor)
    local st = ap and healthSetUnder(sets, ap)
    if st then logOnce("parthp:set", "overlay: part health read from its ArchonHealthAttributeSet") end
    return st
end
-- a part's health, from its set as found again this pass (refreshKept); nil once the set is gone (a part actor
-- replaced or destroyed): never a stale 0 that would read as "Broken"
local function readPart(p)
    if not p.set then return nil end
    return readNum(p.set, "CurrentHealth"), readNum(p.set, "MaxHealth")
end
local function linkedActor(comp)
    for _, n in ipairs(PART_LINKS) do
        local ok, a = pcall(function() return comp[n] end)
        if ok and a ~= nil and type(a) ~= "number" and type(a) ~= "string" and type(a) ~= "boolean" and valid(a) then
            logOnce("partlink:" .. n, "overlay: part components point at their part actor through " .. n)
            return a
        end
    end
    return nil
end
local function findParts(e, sets, comps)
    local parts, seen = {}, {}
    for _, comp in ipairs(comps) do
        if under(pathOf(comp), e.path) then
            local actor = linkedActor(comp)
            if actor then
                local st = partSet(actor, sets)
                local raw = lastName(comp) or ""
                local id = nameOf(actor) or raw
                -- no health object right now (the game is replacing it): the part stays listed, its health unknown
                if not seen[id] then
                    seen[id] = true
                    local p = { raw = raw, name = prettyPart(raw), set = st, actor = actor, comp = comp,
                                setPath = st and pathOf(st), actorPath = pathOf(actor), compPath = pathOf(comp) }
                    p.read = function() return readPart(p) end
                    parts[#parts + 1] = p
                end
            end
        end
    end
    -- always the same order and numbering for the same behemoth (by the component's own name, digits included)
    table.sort(parts, function(a, b) if a.name ~= b.name then return a.name < b.name end return a.raw < b.raw end)
    local count, nth = {}, {}
    for _, p in ipairs(parts) do count[p.name] = (count[p.name] or 0) + 1 end
    for _, p in ipairs(parts) do     -- two "Leg" parts: "Leg 1", "Leg 2"
        if count[p.name] > 1 then local base = p.name nth[base] = (nth[base] or 0) + 1 p.name = base .. " " .. nth[base] end
    end
    return parts
end

-- once per kind of behemoth: what each part is bound to, so a wrong value can be traced in UE4SS.log
local partsLogged = {}
local function logParts(e)
    if partsLogged[e.cls] then return end
    partsLogged[e.cls] = true
    for _, p in ipairs(e.parts) do
        local c, m = p.read()
        log(string.format("overlay:   %s <- %s / %s / %s  %s/%s", p.name, p.raw, (nameOf(p.actor) or "?"):match("([^%.%s]+)$") or "?",
            (nameOf(p.set) or "?"):match("([^%.%s]+)$") or "?", tostring(c), tostring(m)))
    end
end

-- the start of each pass on the game's thread: every kept object found again by its path (see fresh)
local Kept = { at = -1 }
local function refreshKept(now)
    if now - Kept.at < 0.005 then return end   -- once per event: the game frees nothing during one of its events
    Kept.at = now
    for key, e in pairs(Tk.list) do
        e.b = fresh(e.path)
        if not e.b then Tk.list[key] = nil   -- despawned or a new encounter: its parts start fresh
        else
            e.set = fresh(e.setPath)
            for _, p in ipairs(e.parts) do p.actor, p.comp, p.set = fresh(p.actorPath), fresh(p.compPath), fresh(p.setPath) end
        end
    end
    local ps = {}
    for _, path in ipairs(Tk.psPaths or {}) do local o = fresh(path) if o then ps[#ps + 1] = o end end
    Tk.playerStates = ps
end

-- 7.5: a found behemoth's parts are linked again through their own components (kept by path, found again each pass):
-- the component names the part actor in use now. Only when that actor or its health object changed is there a search,
-- for health sets only; only a component that is gone needs the full part search. Before 7.5 every fought behemoth's
-- parts were searched for again every 10 s (two searches, ~70 ms in your game).
local function relinkParts(e, shared)
    local need = false
    local links = {}
    for i, p in ipairs(e.parts) do
        if not p.comp then return "full" end
        local a = linkedActor(p.comp)
        if not a then return "full" end
        local ap = pathOf(a)
        links[i] = { a = a, ap = ap }
        if ap ~= p.actorPath or not p.set then need = true end
    end
    if not need then return "ok" end
    if not shared.sets and not shared.room(1) then return "later" end
    shared.sets = shared.sets or findAll({ "ArchonHealthAttributeSet" })
    for i, p in ipairs(e.parts) do
        local l = links[i]
        if l.ap ~= p.actorPath or not p.set then
            if l.ap ~= p.actorPath then
                logOnce("swap:" .. e.key .. p.name, string.format("overlay: %s %s: the game replaced its part actor (last health %s)%s", e.cls, p.name,
                    tostring(e.partLast[p.name]), e.broke[p.name] and ", broken" or ""))
            end
            local st = partSet(l.a, shared.sets)
            p.actor, p.actorPath = l.a, l.ap
            p.set, p.setPath = st, st and pathOf(st)
        end
    end
    return "relinked"
end

-- 7.5: at most two searches in one pass of the game's thread (a pass with more holds the game up for one long frame:
-- 245 ms at the first hit of a fight before); what is left waits for the next scan
local PASS_SEARCHES = 2
local function trackScan(now)
    Tk.lastScan = now
    local n0 = Cost.passN or Cost.n
    local function room(k) return (Cost.n - n0) + k <= PASS_SEARCHES end
    if now - (Tk.psAt or -100) >= TRACK_PS and next(Tk.list) ~= nil and room(1) then
        Tk.psAt = now
        Tk.playerStates = findAll({ "ArchonPlayerState" })
        Tk.psPaths = {}
        for _, ps in ipairs(Tk.playerStates) do Tk.psPaths[#Tk.psPaths + 1] = pathOf(ps) end
    end
    local shared = { room = room }
    -- 7.5: the behemoth search (every 2 s before) only when there is none known yet, when hits have landed for a second
    -- with none of the known behemoths losing health (a new one), or every 20 s as a safety net
    -- (hits that land on players, or on something that is no behemoth, explain nothing either: each search that finds
    -- nothing new doubles the wait for the next such one, up to 20 s)
    local unexplained = Tk.unexplainedSince and now - Tk.unexplainedSince >= 1.0 and now - (Tk.bScan or -100) >= (Tk.uxWait or 0)
    if (next(Tk.list) == nil or unexplained or now - (Tk.bScan or -100) >= TRACK_SAFETY) and room(1) then
        Tk.bScan = now
        Tk.unexplainedSince = nil
        local found, added = {}, false
        for _, b in ipairs(findAll({ "ArchonBehemoth" })) do
            local key = nameOf(b)
            if key then
                local e = Tk.list[key]
                -- one without a health set (seen on 26 Oct: 3 behemoth objects, one of them never hit) is looked at again
                -- only once a minute, not with every search
                Tk.noSet = Tk.noSet or {}
                if not e and now - (Tk.noSet[key] or -100) >= 60 and (shared.sets or room(1)) then
                    shared.sets = shared.sets or findAll({ "ArchonHealthAttributeSet" })
                    local path = pathOf(b)
                    local st = path and healthSetUnder(shared.sets, path)
                    if not st then Tk.noSet[key] = now end
                    if st then
                        Tk.noSet[key] = nil
                        added = true
                        e = { key = key, b = b, path = path, set = st, setPath = pathOf(st), cls = (key:match("^(%S+)") or ""), last = nil, at = nil,
                              parts = {}, partsAt = -100, partTries = 0, partLast = {}, breaks = {}, broke = {} }
                        Tk.list[key] = e
                    end
                end
                if e then found[key] = true end
            end
        end
        -- gone only when the behemoth object itself is gone (one search not listing it is not enough: dropping the entry
        -- would also drop which parts broke in this fight)
        for key, e in pairs(Tk.list) do if not found[key] and not valid(e.b) then Tk.list[key] = nil end end
        if unexplained and not added then Tk.uxWait = math.min(TRACK_SAFETY, math.max(TRACK_SCAN, (Tk.uxWait or 0) * 2)) else Tk.uxWait = 0 end
    end
    for key, e in pairs(Tk.list) do
        local b = e.b
        if b and not e.gameName and (e.nameTries or 0) < 20 then
            e.nameTries = (e.nameTries or 0) + 1
            local okN, fn = pcall(getField, b, "BehemothFullName")
            local okM, mn = pcall(getField, b, "BehemothMetadataName")
            local function txt(v) if v == nil then return nil end if type(v) == "string" then return v end local ok2, t = pcall(function() return v:ToString() end) return ok2 and type(t) == "string" and t or nil end
            local full, meta = okN and txt(fn), okM and txt(mn)
            if full and full ~= "" and full ~= "None" then e.gameName = full end
            if meta and meta ~= "" and meta ~= "None" then e.metaName = meta end
            if e.gameName or e.nameTries == 20 then
                logOnce("name:" .. e.cls, string.format("overlay: %s is called %s by the game (metadata %s)", e.cls, tostring(e.gameName), tostring(e.metaName)))
            end
        end
        -- 7.1: your own game reads parts too (named properties only, as on the servers): a player who joins someone
        -- else's game has no hunt server on their PC, so this is the only place they can come from
        if b and S.roleKnown then
            local full = false
            if #e.parts == 0 then
                -- none found yet: a few tries, then only while it is being hit (some behemoths have none)
                full = room((shared.sets and 0 or 1) + (shared.comps and 0 or 1)) and now - e.partsAt >= TRACK_PARTS and ((e.partTries or 0) < TRACK_TRIES or (e.at and now - e.at < 5 and now - e.partsAt >= 15))
            elseif e.partsLost or (e.at and now - e.partsAt >= TRACK_REBIND) then
                e.partsAt = now
                e.partsLost = false
                local okR, r = pcall(relinkParts, e, shared)
                if okR and r == "later" then e.partsLost = true e.partsAt = -100 end
                full = (not okR or r == "full") and room((shared.sets and 0 or 1) + (shared.comps and 0 or 1))
                if (not okR or r == "full") and not full then e.partsLost = true e.partsAt = -100 end
                if not okR then logOnce("relink:" .. tostring(r), "overlay: part re-link error: " .. tostring(r)) end
            end
            if full then
                e.partsAt = now
                e.partTries = (e.partTries or 0) + 1
                shared.sets = shared.sets or findAll({ "ArchonHealthAttributeSet" })
                shared.comps = shared.comps or findAll({ "MonsterPartComponent" })   -- one search per scan, shared by every behemoth
                local ok, ps = pcall(findParts, e, shared.sets, shared.comps)
                e.partsLost = false
                if ok then
                    local was = {}
                    for _, p in ipairs(e.parts) do was[p.name] = p.actorPath end
                    for _, p in ipairs(ps) do
                        if was[p.name] and was[p.name] ~= p.actorPath then
                            logOnce("swap:" .. e.key .. p.name, string.format("overlay: %s %s: the game replaced its part actor (last health %s)%s", e.cls, p.name,
                                tostring(e.partLast[p.name]), e.broke[p.name] and ", broken" or ""))
                        end
                    end
                    local before = #e.parts
                    e.parts = ps
                    if #ps > 0 and before == 0 then
                        log(string.format("overlay: %s has %d part(s) (%s)", e.cls, #ps, S.role))
                        pcall(logParts, e)
                    end
                else logOnce("parts:" .. tostring(ps), "overlay: part search failed: " .. tostring(ps)) end
            end
        end
    end
end


-- Stagger: a behemoth's stagger meter is an attribute next to its health. Which names hold it is found once per class
-- of health set from the class's own property list (names and types only: nothing of the object is read for that),
-- and then only those float properties are read. Everything that looks like stagger, element or weakness is logged
-- once, so what the game really has can be checked in the logs.
local STAG_WORDS = { "stagger", "poise" }
local STAG_SKIP = { "damage", "reduce", "rate", "enrage", "time", "delay", "mult", "scale", "bonus", "resist", "regen", "decay", "threshold", "count" }
local stagWay, stagLogged = {}, {}
local function floatProps(o)
    local list = {}
    local ok, c = pcall(function() return o:GetClass() end)
    for _ = 1, 10 do
        if not (ok and c and valid(c)) then break end
        pcall(function() c:ForEachProperty(function(p)
            local okN, n = pcall(function() return p:GetFName():ToString() end)
            local okT, t = pcall(function() return p:GetClass():GetFName():ToString() end)
            if okN and n then list[#list + 1] = { name = n, kind = okT and t or "?" } end
        end) end)
        local okS, sup = pcall(function() return c:GetSuperStruct() end)
        ok, c = okS, sup
    end
    return list
end
local function has(l, words) for _, w in ipairs(words) do if l:find(w, 1, true) then return true end end return false end
local function logLooks(what, o)
    local cls = (nameOf(o) or "?"):match("^(%S+)") or "?"
    if stagLogged[cls] then return end
    stagLogged[cls] = true
    local seen = {}
    for _, p in ipairs(floatProps(o)) do
        local l = p.name:lower()
        if has(l, { "stagger", "poise", "element", "weak", "resist", "terra", "blaze", "frost", "shock", "radiant", "umbral" }) then
            seen[#seen + 1] = p.name .. ":" .. p.kind
        end
    end
    log("overlay: " .. what .. " " .. cls .. " has " .. (#seen > 0 and table.concat(seen, ", ") or "nothing stagger- or element-like"))
end
-- the reader for this set's stagger (current, max), or false
local function stagReader(set)
    local cls = (nameOf(set) or "?"):match("^(%S+)") or "?"
    local way = stagWay[cls]
    if way == nil then
        local cur, max
        for _, p in ipairs(floatProps(set)) do
            local l = p.name:lower()
            if (p.kind == "FloatProperty" or p.kind == "DoubleProperty") and has(l, STAG_WORDS) and not has(l, STAG_SKIP) then
                if l:find("max", 1, true) then max = max or p.name
                elseif l:find("current", 1, true) or l:find("cur", 1, true) or l == "stagger" or l == "poise" then cur = cur or p.name end
            end
        end
        way = (cur and max) and { cur, max } or false
        stagWay[cls] = way
        log("overlay: stagger on " .. cls .. ": " .. (way and (way[1] .. " / " .. way[2]) or "not found"))
    end
    if not way then return false end
    return function(st)
        if not st then return nil end
        return readNum(st, way[1]), readNum(st, way[2])
    end
end

-- where an actor is: its root component's RelativeLocation (the root of a behemoth or a player is not attached to
-- anything, so that is its place in the world). Property reads only; nil when it cannot be read.
local function locOf(a)
    local okR, rc = pcall(getField, a, "RootComponent")
    if not (okR and rc ~= nil and type(rc) ~= "number" and valid(rc)) then return nil end
    local okL, l = pcall(getField, rc, "RelativeLocation")
    if not okL or l == nil then return nil end
    local okX, x, y, z = pcall(function() return l.X, l.Y, l.Z end)
    if okX and type(x) == "number" and type(y) == "number" then return x, y, (type(z) == "number" and z or 0) end
    return nil
end
-- your character, in your own game (nil on a hunt server: it has every player and cannot tell which one is you)
local function myPawn()
    local pc = S.role == "game" and fresh(S.localPCPath)
    if not pc then return nil end
    local ok, p = pcall(getField, pc, "Pawn")
    return (ok and p ~= nil and type(p) ~= "number" and valid(p)) and p or nil
end
-- the behemoth you are fighting: of those hit in the last 15 s, the one nearest to you (two players fighting two
-- behemoths each get their own); on a hunt server, or when places cannot be read, the one hit last
local function pickMine(now)
    local recent = {}
    for _, e in pairs(Tk.list) do if e.at and now - e.at < TRACK_MINE and valid(e.b) then recent[#recent + 1] = e end end
    local pawn = myPawn()
    local px, py, pz
    if pawn then px, py, pz = locOf(pawn) end
    local best, bestD = nil, nil
    for _, e in ipairs(recent) do
        local x, y, z = locOf(e.b)
        e.x, e.y, e.z = x, y, z
        local d = (px and x) and ((x - px) ^ 2 + (y - py) ^ 2 + (z - pz) ^ 2) or nil
        if d and (not bestD or d < bestD) then best, bestD = e, d
        elseif not bestD and (not best or e.at > best.at) then best = e end
    end
    if bestD then logOnce("mine:near", "overlay: picks the behemoth nearest to you among those being hit") end
    return best, recent
end

local function trackJson(e)
    local rawHp = readNum(e.set, "CurrentHealth")
    local hp, mx = fin(rawHp or 0), fin(readNum(e.set, "MaxHealth") or 0)
    local dead = rawHp ~= nil and rawHp == rawHp and rawHp <= 0   -- a reading of NaN is not "dead"
    local ps = {}
    e.partMax = e.partMax or {}
    for _, p in ipairs(e.parts) do
        local c, m = p.read()
        if c == nil and e.partLast[p.name] ~= nil then e.partsLost = true end
        m = m and fin(m)
        if m and m > 0 then e.partMax[p.name] = m end
        m = m or e.partMax[p.name]
        -- "Body" has millions of health (far more than the behemoth): not a part you can break, so it is not shown
        if m and m > 0 and not (mx > 0 and m > mx) then
            if e.broke[p.name] then
                -- broken: confirmed by the game or by its health reaching 0. What the game puts in its health after
                -- that (a refill, a new health object) is not this part's health any more: it is sent as 0, broken
                ps[#ps + 1] = string.format('["%s",0,%.0f,%d,1]', clean(p.name), m, e.breaks[p.name] or 0)
            elseif c ~= nil and c == c and c > -1e9 and c < 1e12 then
                ps[#ps + 1] = string.format('["%s",%.0f,%.0f,%d,0]', clean(p.name), math.min(math.max(c, 0), m), m, e.breaks[p.name] or 0)
            else
                -- no reading right now (the game is replacing its health object): sent as unknown, not as a number
                ps[#ps + 1] = string.format('["%s",-1,%.0f,%d,0]', clean(p.name), m, e.breaks[p.name] or 0)
            end
        end
    end
    local stg = ""
    if e.stag == nil then
        pcall(logLooks, "behemoth", e.b)
        pcall(logLooks, "health set", e.set)
        local ok, r = pcall(stagReader, e.set)
        e.stag = ok and r or false
    end
    if e.stagFn and e.stagFn[2] and e.stagFn[2] > 0 then
        stg = string.format(',"stg":[%.0f,%.0f]', math.max(fin(e.stagFn[1]), 0), fin(e.stagFn[2]))
    elseif e.stagComp then
        stg = string.format(',"stg":[%.0f,%.0f]', math.max(fin(e.stagComp[1]), 0), fin(e.stagComp[2]))
    elseif e.stag then
        local sc, sm = e.stag(e.set)
        if sc and sm and sm > 0 then stg = string.format(',"stg":[%.0f,%.0f]', math.max(fin(sc), 0), fin(sm)) end
    end
    if e.stagDmg then stg = stg .. string.format(',"sdmg":%.0f', math.max(fin(e.stagDmg), 0)) end
    -- the game's own name for this behemoth, and its metadata row name (the panel prefers these to any mapping)
    if e.gameName then stg = stg .. ',"nm":"' .. tostring(e.gameName):gsub('[%c"\\]', '') .. '"' end
    if e.metaName then stg = stg .. ',"mn":"' .. tostring(e.metaName):gsub('[%c"\\]', '') .. '"' end
    if e.dispArch then stg = stg .. ',"da":"' .. tostring(e.dispArch):gsub('[%c"\\]', '') .. '"' end
    if e.dispClass and e.dispClass ~= "" then stg = stg .. ',"dc":"' .. tostring(e.dispClass):gsub('[%c"\\]', '') .. '"' end
    if e.x then stg = stg .. string.format(',"loc":[%.0f,%.0f,%.0f]', fin(e.x), fin(e.y), fin(e.z)) end
    return string.format('{"key":"%s","cls":"%s","cur":%.0f,"max":%.0f,"at":%d,"n":%d,"dead":%s,"parts":[%s]%s}',
        clean(e.key), clean(e.cls), math.max(hp, 0), mx, e.atTime or 0, e.n or 0, tostring(dead), table.concat(ps, ","), stg)
end

local resolveBreak   -- defined with the break events below; called by the tracking loop
local refillBreaks   -- the same rule without an event (your own game never gets one)
local function trackTick(now)
    if not T.track or not TrackFile or not InGT then return end   -- 7.3: the game's thread only (trackBeat writes the rest)
    Tk.cleared = false
    Tk.lastGT = now
    refreshKept(now)
    -- your own game searches for behemoths only within 30 s of a hit (the hunt server tracks the fight; in town, where
    -- the game loads the most, it never searches); a hunt server searches every second
    local nearFight = S.role ~= "game" or (Tk.hitAt and now - Tk.hitAt < 30)
    if nearFight and now - Tk.lastScan >= TRACK_SCAN then trackScan(now) end
    local anyHit = false
    -- what dropped since last time: that behemoth becomes the one to show
    local best = nil
    for key, e in pairs(Tk.list) do
        if not e.b then Tk.list[key] = nil   -- despawned or a new encounter: its parts start fresh
        elseif not e.set then
            -- replaced by the game: looked for again (at most every 3 s; one search goes through every object)
            if now - (e.setAt or -100) >= TRACK_PARTS then
                e.setAt = now
                local st = healthSetUnder(findAll({ "ArchonHealthAttributeSet" }), e.path)
                if st then e.set, e.setPath = st, pathOf(st) end
            end
        else
            local hp = readNum(e.set, "CurrentHealth")
            local hit = hp and e.last and hp < e.last - 0.01
            if hp then e.last = hp end
            for _, p in ipairs(e.parts) do
                local c, m = p.read()
                local was = e.partLast[p.name]
                -- its health object is gone (replaced): found again by the scan. A part that never had one is not "lost"
                -- (it would make the scan search every object every second for the whole fight)
                if c == nil and e.partLast[p.name] ~= nil then e.partsLost = true end
                if c and was and c < was - 0.01 then hit = true end
                -- a break: the game often refills that part right away (it can break again), so breaks are counted
                if c and was and was > 0 and c <= 0 then
                    e.breaks[p.name] = (e.breaks[p.name] or 0) + 1
                    -- broken for the rest of this fight: the game refills a broken part's health, that is not a repair
                    if not e.broke[p.name] then e.broke[p.name] = "health" end
                end
                if c and was and ((was > 0 and c <= 0) or (was <= 0 and c > 0)) then
                    log(string.format("overlay: %s %s %s (%.0f/%s)", e.cls, p.name, c <= 0 and "broke" or "back", c, tostring(m)))
                end
                if c ~= nil then
                    -- 7.4: the reading before this one, however old (readings come with hits now, 7.3; a slow weapon
                    -- hits every 2 s, so "the low of the last 1.5 s" alone missed the refill on the breaking hit)
                    e.partPrev = e.partPrev or {}
                    if was ~= nil and was ~= c then e.partPrev[p.name] = was end
                    e.partLast[p.name] = c   -- a missing reading keeps the last real one for comparing
                    e.partLow = e.partLow or {}
                    local low = e.partLow[p.name]
                    if not low or c <= low.v or now - low.at > 1.5 then e.partLow[p.name] = { v = c, at = now } end
                end
            end
            if e.pending then local okR, errR = pcall(resolveBreak, e, now) if not okR then logOnce("resolve:" .. tostring(errR), "overlay: break check error: " .. tostring(errR)) e.pending = nil end end
            if not e.pending then local okF, errF = pcall(refillBreaks, e) if not okF then logOnce("refill:" .. tostring(errF), "overlay: refill check error: " .. tostring(errF)) end end
            if hit then Tk.n = Tk.n + 1 e.at, e.atTime, e.n = now, os.time(), Tk.n anyHit = true end
            if hp and hp <= 0 and not e.deadAt then e.deadAt = now end
            if hp and hp > 0 then e.deadAt = nil end   -- 0 at spawn (health not filled in yet) is not dead
            if e.deadAt and now - e.deadAt > TRACK_LINGER then e.at = nil end
        end
    end
    -- 7.5: a hit that no known behemoth's health shows (for a second) means a new one: the next scan searches
    if Tk.hitAt == now then
        if anyHit then Tk.unexplainedSince, Tk.uxWait = nil, 0 elseif not Tk.unexplainedSince then Tk.unexplainedSince = now end
    end
    local recent
    best, recent = pickMine(now)
    Tk.mine = best
    local body = best and trackJson(best) or "null"
    -- a hunt server also lists the other behemoths being hit, with their places: the panel matches the one your own
    -- game picked (actor names differ between your game and the server, so by kind and place)
    if S.role == "server" and best then
        table.sort(recent, function(a, b) return a.at > b.at end)
        local more = {}
        for _, e in ipairs(recent) do if e ~= best and #more < TRACK_LIST - 1 then more[#more + 1] = trackJson(e) end end
        if #more > 0 then body = body .. ',"list":[' .. table.concat(more, ",") .. "]" end
    end
    if body == Tk.lastBody and now - Tk.lastWrite < TRACK_BEAT then return end
    local f = io.open(TrackFile, "w")
    if not f then logOnce("notrack", "cannot write " .. TrackFile .. " (the panel creates the track folder)") return end
    f:write(string.format('{"role":"%s","time":%d,"b":%s}', S.role, os.time(), body))
    f:close()
    if best and body ~= Tk.lastBody and not Tk.logged then Tk.logged = true log("overlay: tracking " .. best.cls .. " (" .. S.role .. ")") end
    Tk.lastBody, Tk.lastWrite = body, now
end

-- on the timer thread: no game object, only the file. The last reading is written again every second while the fight
-- goes on (the panel drops a file older than 4 s), and dropped 4 s after its behemoth died or 30 s after the last hit
local function trackBeat(now)
    if not TrackFile then return end
    if not T.track then
        if not Tk.cleared then os.remove(TrackFile) Tk.cleared = true Tk.lastBody = nil end
        return
    end
    if not Tk.lastBody or Tk.lastBody == "null" or now - Tk.lastWrite < TRACK_BEAT then return end
    local idle = now - (Tk.lastGT or now)
    local body = Tk.lastBody
    if idle > TRACK_STALE or (idle > TRACK_LINGER and body:find('"dead":true', 1, true)) then body = "null" end
    local f = io.open(TrackFile, "w")
    if not f then return end
    f:write(string.format('{"role":"%s","time":%d,"b":%s}', S.role, os.time(), body))
    f:close()
    Tk.lastBody, Tk.lastWrite = body, now
end

---------------------------------------------------------------- stagger from the game's own functions (hit hook only)
-- The game keeps a behemoth's stagger behind functions (GetCurrentStaggerHealth / GetMaxStaggerHealth, in the game's
-- exe), not properties. Functions are only called from the hit hook, which runs on the game's own thread.
-- Three places, all the game's own, read on every hit (the hit hook runs on the game's thread):
--   1. the behemoth's meter: ArchonBehemoth GetCurrentStaggerHealth / GetMaxStaggerHealth. In the 3.8 logs these
--      answered 0/0 for every behemoth, so the meter was never shown; it is still asked, and used once it gives a max.
--   2. its stagger component (staggerable_bpc): its stagger numbers, found by name once per kind (and logged).
--   3. the stagger damage the players have dealt toward the next stagger: each player state's own count
--      (ArchonPlayerState GetCurrentStaggerDamageDealt, which the game resets when the behemoth staggers), summed.
-- Whichever gives a meter (current and max) is shown as the bar; the damage dealt is shown as a number.
-- 6.7: the game's display name (ArchonBehemoth GetBehemothNameDataNative), asked by 6.5 and 6.6 on the first hit,
-- crashed the hunt server inside UE4SS (an access violation pcall cannot catch). It is no longer asked; the panel names
-- behemoths from the game's row name (BehemothFullName), its kill tokens and its item texts.

local stagSeen = {}
local stagCompProps = {}   -- class -> { cur = name, max = name } or false
local function isObj(v) return v ~= nil and type(v) ~= "number" and type(v) ~= "string" and type(v) ~= "boolean" and valid(v) end
local function stagFromFunctions()
    local best = Tk.mine   -- the behemoth the overlay shows (trackTick picks it, and found it again this pass)
    if not best or not best.b or not InGT then return end
    -- 1. the behemoth's own meter
    local okC, c = pcall(callM, best.b, "GetCurrentStaggerHealth")
    local okM, m = pcall(callM, best.b, "GetMaxStaggerHealth")
    if okC and okM and type(c) == "number" and type(m) == "number" then
        best.stagFn = { c, m }
        if m > 0 and not stagSeen.fn then stagSeen.fn = true log(string.format("overlay: stagger meter from GetCurrent/GetMaxStaggerHealth (%.0f/%.0f)", c, m)) end
    end
    -- 2. its stagger component
    local okS, comp = pcall(getField, best.b, "staggerable_bpc")
    if okS and isObj(comp) then
        local cls = (nameOf(comp) or "?"):match("^(%S+)") or "?"
        local w = stagCompProps[cls]
        if w == nil then
            local nums, cur, max = {}, nil, nil
            for _, pr in ipairs(floatProps(comp)) do
                if pr.kind == "FloatProperty" or pr.kind == "IntProperty" or pr.kind == "DoubleProperty" then
                    local l = pr.name:lower()
                    local v = readNum(comp, pr.name)
                    nums[#nums + 1] = pr.name .. "=" .. tostring(v)
                    if l:find("stagger", 1, true) or l:find("poise", 1, true) or l:find("threshold", 1, true) then
                        if l:find("max", 1, true) or l:find("threshold", 1, true) then max = max or pr.name
                        elseif l:find("cur", 1, true) or l:find("damage", 1, true) or l:find("amount", 1, true) or l:find("health", 1, true) then cur = cur or pr.name end
                    end
                end
            end
            w = (cur and max) and { cur = cur, max = max } or false
            stagCompProps[cls] = w
            log("overlay: stagger component " .. cls .. " numbers: " .. (#nums > 0 and table.concat(nums, ", ", 1, math.min(#nums, 40)) or "none")
                .. (w and (" -> meter " .. w.cur .. " / " .. w.max) or ""))
        end
        if w then
            local cc, mm = readNum(comp, w.cur), readNum(comp, w.max)
            if cc and mm and mm > 0 then best.stagComp = { cc, mm } end
        end
    end
    -- 3. stagger damage dealt toward the next stagger (the player states are found by the overlay's own scan)
    local sum, any = 0, false
    for _, ps in ipairs(Tk.playerStates or {}) do
        if valid(ps) then
            local ok, v = pcall(callM, ps, "GetCurrentStaggerDamageDealt")
            if ok and type(v) == "number" then sum, any = sum + v, true end
        end
    end
    if any then
        best.stagDmg = sum
        if sum > 0 and not stagSeen.dmg then stagSeen.dmg = true log(string.format("overlay: stagger damage from the players' GetCurrentStaggerDamageDealt (%.0f)", sum)) end
    elseif not stagSeen.nodmg and #(Tk.playerStates or {}) > 0 then
        stagSeen.nodmg = true
        log("overlay: GetCurrentStaggerDamageDealt not available on " .. #Tk.playerStates .. " player state(s)")
    end
end

-- The game's own answer to "is this part broken" (MonsterPartComponent IsBroken), asked on the game thread (hit hook)
-- for the behemoth being fought. Once broken, a part stays broken for that fight (e.broke is never cleared; a new
-- fight is a new behemoth entry).
local brokeFnOk = nil
local function markBroken(e, p, how)
    if e.broke[p.name] then return end
    e.broke[p.name] = how
    e.lastMarkAt = os.clock()
    log(string.format("overlay: %s %s broken (%s)", e.cls, p.name, how))
end
local function partsBrokenIn(best)
    for _, p in ipairs(best.parts) do
        if not best.broke[p.name] and p.comp then
            local ok, v = pcall(callM, p.comp, "IsBroken")
            if ok and type(v) == "boolean" then
                if brokeFnOk == nil then brokeFnOk = true log("overlay: part break state from the game (IsBroken)") end
                if v then markBroken(best, p, "the game says so") end
            elseif brokeFnOk == nil then
                brokeFnOk = false
                log("overlay: no IsBroken on parts (" .. tostring(v) .. "); a part counts as broken when its health reaches 0 or the game reports the break")
                return
            end
        end
    end
end
-- every behemoth hit in the last minute (not only the latest: two in a fight)
local function partsBrokenFromGame()
    if brokeFnOk == false then return end
    local now = os.clock()
    if not InGT then return end
    refreshKept(now)
    for _, e in pairs(Tk.list) do
        if e.at and now - e.at < 60 and e.b then partsBrokenIn(e) end
    end
end
-- The game's own "a part broke" events (its mastery and combat telemetry listen to them; on the hunt server). The
-- part is found from what the event carries (the part component, its part actor, or its name); if that cannot be
-- matched, every part of the behemoths being fought is asked IsBroken at once.
-- Which part broke. The game's break events (seen in 3.9.2's logs) carry only the behemoth, its parts' IsBroken stayed
-- false, and a tail's health is refilled in the same instant it breaks, so neither a 0 nor IsBroken ever shows. What
-- does show, right after the game says "a part broke on this behemoth", is the broken part itself: its health is at 0
-- now, or its health object is gone, or its health jumps back up (the refill: part health never rises otherwise, apart
-- from regrowing after a break). That part, and only that part, is marked broken. If none does within 4 seconds, the
-- break is logged as not identified and no part is marked.
local BREAK_WINDOW = 4.0
local breakEvents = 0
local function armBreak(e, why)
    local now = os.clock()
    -- the same break reported by several of the game's listeners: one window, measured from the first
    if e.pending and now - e.pending.at < 0.5 then return end
    if e.lastMarkAt and now - e.lastMarkAt < 1 then return end   -- this break was just identified
    local before, gone = {}, {}
    for _, p in ipairs(e.parts) do
        if not e.broke[p.name] then
            local c = p.read()
            if c ~= nil and c <= 0 then markBroken(e, p, why .. ", health 0") return end
            -- the lowest real reading of the last 1.5 s: a refill sampled just before the event still counts
            local low = e.partLow and e.partLow[p.name]
            local b = (low and now - low.at <= 1.5 and low.v) or e.partLast[p.name]
            local prev = e.partPrev and e.partPrev[p.name]   -- 7.4: the reading before the last, however old
            if prev and (not b or prev < b) then b = prev end
            before[p.name] = b
            if c == nil and e.partLast[p.name] ~= nil then gone[#gone + 1] = p end
        end
    end
    if #gone == 1 then markBroken(e, gone[1], why .. ", its health object removed") return end
    e.pending = { at = now, why = why, before = before }
end
-- called on every sample while a break is waiting to be identified
-- 7.2: the game's break events fire on the hunt server only, and a broken part is refilled at once, often before
-- your game reads it at 0. A player who joins someone else's game has no hunt server on their PC, so their overlay
-- missed most breaks (25 Oct: the host's server marked 7 on a Skraev, the game 2). In your own game a refill alone
-- marks the break, by the rule resolveBreak uses: the part's health rose 10%+ of max from its low of the last 1.5 s
-- and is back to 90%+, or rose 50%+ and is at 70%+, while no other part rose by a quarter (several parts rising
-- together is the game rescaling health, as when a player joins; nothing is marked then). Hunt servers use it too,
-- besides their break events, so the host's overlay and a joining player's follow the same rule
refillBreaks = function(e)
    local best, bestRise, secondRise, bc, bm, low = nil, 0, 0, nil, nil, nil
    for _, p in ipairs(e.parts) do
        local lw = e.partLow and e.partLow[p.name]
        local prev = e.partPrev and e.partPrev[p.name]
        local base = lw and lw.v
        if prev and (not base or prev < base) then base = prev end   -- the previous reading, however old (7.4)
        if base and not e.broke[p.name] then
            local c, m = p.read()
            if c and m and m > 0 then
                local rise = (c - base) / m
                if rise > bestRise then best, secondRise, bestRise, bc, bm, low = p, bestRise, rise, c, m, base
                elseif rise > secondRise then secondRise = rise end
            end
        end
    end
    if best and secondRise < 0.25 and ((bestRise >= 0.1 and bc >= 0.9 * bm) or (bestRise >= 0.5 and bc >= 0.7 * bm)) then
        markBroken(e, best, string.format("its health refilled from %.0f to %.0f of %.0f, no break event needed", low, bc, bm))
    end
end

resolveBreak = function(e, now)
    local pb = e.pending
    if not pb then return end
    local best, bestRise, secondRise = nil, 0, 0
    for _, p in ipairs(e.parts) do
        if not e.broke[p.name] then
            local c, m = p.read()
            local b = pb.before[p.name]
            if c ~= nil and c <= 0 then markBroken(e, p, pb.why .. ", health 0") e.pending = nil return end
            if c ~= nil and b ~= nil and m and m > 0 then
                local rise = (c - b) / m
                if rise > bestRise then best, bestRise, secondRise = p, rise, bestRise
                elseif rise > secondRise then secondRise = rise end
            end
        end
    end
    local bc, bm = nil, nil
    if best then bc, bm = best.read() end
    -- the broken part: its health refilled. Refills seen in real hunts (25 Oct): to 100%, or to 87-93% of max, then
    -- often hit again within the window (ending at 73-89%), always a jump of 50-100% of max; nothing else rose more
    -- than 27% in those windows. So: back up to 90% or more after any rise of 10%+ (as before), or a jump of half its
    -- health or more ending at 70% or more, when no other part rose by a quarter at the same time (two candidates:
    -- none is marked)
    local refilled = best and bc and bm and bm > 0 and (
        (bestRise >= 0.1 and bc >= 0.9 * bm) or (bestRise >= 0.5 and bc >= 0.7 * bm and secondRise < 0.25))
    if refilled then
        local c, m = best.read()
        markBroken(e, best, string.format("%s, its health refilled from %.0f to %.0f of %.0f", pb.why, pb.before[best.name] or 0, c or 0, m or 0))
        e.pending = nil
    elseif now - pb.at > BREAK_WINDOW then
        local snap = {}
        for _, p in ipairs(e.parts) do
            local c, m = p.read()
            if not e.broke[p.name] and m and m > 0 then snap[#snap + 1] = string.format("%s %s->%s", p.name, tostring(pb.before[p.name] and math.floor(pb.before[p.name])), tostring(c and math.floor(c))) end
        end
        log("overlay: " .. e.cls .. ": a part broke (" .. pb.why .. ") but it could not be told which; none marked. " .. table.concat(snap, ", "))
        e.pending = nil
    end
end

local function onPartBrokenEvent(hookName, ...)
    if not T.track then return end
    local args, names = { ... }, {}
    local matched, behs = false, {}
    for i = 2, #args do
        local ok, v = pcall(function() return args[i]:get() end)
        if ok and v ~= nil then
            local n = (type(v) == "string" or type(v) == "number" or type(v) == "boolean") and tostring(v) or (function() local okT, t = pcall(function() return v:ToString() end) return okT and type(t) == 'string' and t or nil end)() or nameOf(v)
            if n then
                names[#names + 1] = n
                for _, e in pairs(Tk.list) do
                    if n == e.key then behs[#behs + 1] = e end
                    for _, p in ipairs(e.parts) do
                        local cn, an = p.comp and nameOf(p.comp), p.actor and nameOf(p.actor)
                        if n == cn or n == an or (#n > 2 and (n == p.raw or (an and an:sub(-#n - 1) == "_" .. n) or (cn and cn:sub(-#n - 1) == "." .. n))) then
                            markBroken(e, p, "the game's break event") matched = true
                        end
                    end
                end
            end
        end
    end
    breakEvents = breakEvents + 1
    if breakEvents <= 20 then log("overlay: break event " .. hookName .. " carrying: " .. (#names > 0 and table.concat(names, " | ") or "nothing readable")) end
    if matched then Tk.lastBody = nil return end
    pcall(partsBrokenFromGame)   -- the game's own IsBroken, where it answers
    -- the event names the behemoth (or nothing: then the behemoths hit in the last few seconds)
    if #behs == 0 then
        local now = os.clock()
        for _, e in pairs(Tk.list) do if e.at and now - e.at < 5 then behs[#behs + 1] = e end end
    end
    for _, e in ipairs(behs) do
        local okA, errA = pcall(armBreak, e, "the game's break event")
        if not okA then logOnce("arm:" .. tostring(errA), "overlay: break check error: " .. tostring(errA)) end
    end
    Tk.lastBody = nil   -- written at the next tick
end

---------------------------------------------------------------- status heartbeat for the panel
local lastStatus, lastRead = -100, -100
local function writeStatus(now)
    lastStatus = now
    if not StatusFile then return end
    local f = io.open(StatusFile, "w")
    if not f then logOnce("nostatus", "cannot write " .. StatusFile .. " (the panel creates the status folder when it installs the mod)") return end
    local fns = invFns and table.concat({ table.unpack(invFns, 1, math.min(#invFns, 6)) }, ",") or ""
    f:write(string.format('{"v":"%s","role":"%s","time":%d,"invFns":"%s","called":"%s","calledAt":%d}',
        MOD_VERSION, S.role, os.time(), clean(fns), clean(S.called or ""), S.calledAt or 0))
    f:close()
end

---------------------------------------------------------------- loop
-- the timer thread (7.3): this mod's files only, never a game object (see search)
local function step()
    local now = os.clock()
    if now - lastRead >= READ_EVERY then
        lastRead = now
        readToggles()
        pcall(checkRefresh)
    end
    local okT, errT = pcall(trackBeat, now)
    if not okT then logOnce("track:" .. tostring(errT), "overlay error: " .. tostring(errT)) end
    if now - lastStatus >= STATUS_EVERY then pcall(writeStatus, now) end
    -- 7.5: once a minute, what the overlay cost the game's thread (only when it searched)
    Cost.at = Cost.at or now
    if now - Cost.at >= 60 then
        if Cost.n > 0 then log(string.format("cost last minute: %d search(es), %.0f ms searching, longest game-thread pass %.0f ms", Cost.n, Cost.ms, Cost.worst)) end
        Cost.n, Cost.ms, Cost.worst, Cost.at = 0, 0, 0, now
    end
end

LoopAsync(TICK_MS, function()
    local ok, err = pcall(step)
    if not ok then logOnce("step:" .. tostring(err), "loop error: " .. tostring(err)) end
    return false
end)

-- a hit lands: the overlay answers at once, on the game's own thread (only while it is on)
-- Repeaters land many hits a second: the overlay answers 8 a second at most (it reads every part and writes a file,
-- so not on every bullet)
local lastHitTrack = -1
local hooked, hookErr = pcall(function()
    RegisterHook("/Script/Archon.ArchonCombatTextComponent:MulticastSendMultitypeCombatText", function()
        if PendingRefresh then onGameThread(function() end) end   -- an instant refresh waiting for the game's thread
        if not T.track then return end
        local now = os.clock()
        Tk.hitAt = now
        if T.track and now - lastHitTrack >= 0.125 then
            lastHitTrack = now
            onGameThread(trackTick, now)   -- the overlay moves with the hit, not on the next timer tick
            onGameThread(stagFromFunctions)
            onGameThread(partsBrokenFromGame)
        end
    end)
end)
log(hooked and "hit hook ready" or ("hit hook not available (" .. tostring(hookErr) .. "); the timer still runs"))

local brkHooks = {}
for _, fn in ipairs({ "/Script/Archon.ArchonTelemetryComponent_Combat:RecordBehemothPartBroken", "/Script/Archon.MasteryComponent:OnBehemothPartBroken",
                      "/Script/Archon.Objective_BehemothParts:OnPartBroken" }) do
    local short = fn:match(":([%w_]+)$")
    if pcall(RegisterHook, fn, function(...) local a = { ... } onGameThread(onPartBrokenEvent, short, table.unpack(a)) end) then brkHooks[#brkHooks + 1] = fn:match("%.([%w_]+:[%w_]+)$") end
end
log("part break events hooked: " .. (#brkHooks > 0 and table.concat(brkHooks, ", ") or "none (breaks come from IsBroken and health)"))

-- the game's own quest events (they fire when a quest's progress or status changes, and when quests arrive): kept
-- after the quest tracker went (7.3) as game-thread moments for an instant refresh in town, where nothing is hit
local qHooks = {}
for _, fn in ipairs({ "/Script/Archon.HUDObjectiveTracker:OnQuestObjectiveUpdated", "/Script/Archon.HUDObjectiveTracker:OnQuestStatusUpdated",
                      "/Script/Archon.MarkerSystemComponent:OnQuestObjectiveUpdated", "/Script/Archon.MarkerSystemComponent:OnQuestStatusUpdated",
                      "/Script/Archon.QuestSystemComponent:OnRep_Series", "/Script/Archon.QuestSystemComponent:OnRep_NumExpectedQuests" }) do
    local ok = pcall(RegisterHook, fn, function() if PendingRefresh then onGameThread(function() end) end end)
    if ok then qHooks[#qHooks + 1] = fn:match(":(.+)$") end
end
log("quest events hooked (for instant refresh): " .. (#qHooks > 0 and table.concat(qHooks, ", ") or "none"))

log("loaded (v" .. MOD_VERSION .. ": overlay tracking with stagger and broken parts, instant refresh)")
