-- SPDX-License-Identifier: AGPL-3.0-only
-- Lantern Client: the owner's damage multiplier against behemoths, behemoth tracking for the Lantern overlay, for
-- Dauntless 1.14.7 (Dauntless Forever / UE4SS 3.0.1), and the experimental instant inventory refresh.
--
-- The panel writes trainer-toggles.json into this mod's folder; this script reads it twice a second. The folder is
-- shared by your game and every hidden server copy (they all run the same exe), so the multiplier reaches the hunt
-- servers, which own behemoth health ("Also run mods on my servers" must be on).
--
-- Kept light on purpose: with the multiplier at x1, the overlay off and instant refresh off, it only reads that small
-- file. Otherwise it looks for behemoths every 1 to 2 seconds and checks their health every 150 ms and on every hit.
-- Only property reads and writes are used. Logged as [DFTrainer] in UE4SS.log.

local MOD_VERSION  = "6.8"
local TICK_MS      = 150    -- how often behemoth health is checked while the multiplier is on
local RESCAN_EVERY = 2.0    -- seconds between searches for behemoths
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
local function writeNum(o, prop, v)
    local ok = pcall(function() o[prop] = v end)
    return ok
end
local function under(objPath, ownerPath)
    return objPath and ownerPath and objPath:sub(1, #ownerPath + 1) == ownerPath .. "."
end
-- Object searches (FindAllOf) go through every object the game has. They run on the mod's own timer thread only: on
-- the game's thread (hit, break and quest events) the last search's result is used instead, so a search never holds
-- up a frame. 6.6: UE4SS's object cache, which made searches cheap, crashed the game while it loaded many items at
-- once (the panel turns it off), so searches are also kept to where they are needed.
local InGT = false            -- true while a game-thread event runs
local lastFound = {}          -- class -> what the last search found
local function search(cls)
    if InGT then return lastFound[cls] or {} end
    local ok, list = pcall(FindAllOf, cls)
    list = ok and list or {}
    lastFound[cls] = list
    return list
end
PendingRefresh = nil           -- an instant refresh waiting for the game's thread
local function onGameThread(fn, ...)
    local was = InGT
    InGT = true
    if PendingRefresh and runPendingRefresh then pcall(runPendingRefresh) end
    local ok, err = pcall(fn, ...)
    InGT = was
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
local T = { damage = 1, refresh = false, refreshFn = "", locked = false, track = false, quests = false }
local togglesText = ""

local function parseToggles(s)
    local function flag(k) return s:find('"' .. k .. '"%s*:%s*true') ~= nil end
    T.damage  = math.max(1, math.min(1000, tonumber(s:match('"damage"%s*:%s*(%-?[%d%.]+)')) or 1))
    T.refresh = flag("refresh")
    T.refreshFn = s:match('"refreshFn"%s*:%s*"([%w_]*)"') or ""
    T.locked = flag("locked")   -- not the owner's panel: no multiplier, no refresh
    if T.locked then T.damage, T.refresh = 1, false end
    T.track = flag("track")     -- the behemoth overlay is on (anyone's panel)
    T.quests = flag("quests")   -- the quest tracker is on (anyone's panel)
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
        log(string.format("toggles: damage=x%g refresh=%s track=%s quests=%s", T.damage, tostring(T.refresh), tostring(T.track), tostring(T.quests)))
    end
end

---------------------------------------------------------------- what is in this process
local S = { role = "server", behemoths = {}, owners = {} }
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
    if InGT then return end   -- searches: on the timer thread only
    lastRescan = now
    local isGame, owners = false, {}
    for _, pc in ipairs(findAll(PC_CLASSES)) do
        if isLocal(pc) then isGame = true end
        if T.refresh then
            local okP, pawn = pcall(function() return pc.Pawn end)
            if okP and valid(pawn) then
                local okS, ps = pcall(function() return pc.PlayerState end)
                owners[#owners + 1] = { path = pathOf(pawn), psPath = (okS and valid(ps)) and pathOf(ps) or nil, pcPath = pathOf(pc) }
            end
        end
    end
    if not isGame and S.role ~= "game" then isGame = hasLocalPlayer() end
    -- once your game, always your game (a server copy never gets a local player)
    S.role = (isGame or S.role == "game") and "game" or "server"
    S.roleKnown = true
    S.owners = owners

    local behemoths = {}
    if T.damage > 1 then
        local okB, blist = true, search("ArchonBehemoth")
        local sets = (okB and blist and #blist > 0) and findAll({ "ArchonHealthAttributeSet" }) or {}
        for _, b in ipairs(okB and blist or {}) do
            if valid(b) then
                local bp = pathOf(b)
                local best, bestMax = nil, 0
                for _, s in ipairs(sets) do
                    if under(pathOf(s), bp) then
                        local m = readNum(s, "MaxHealth") or 0
                        if m > bestMax then best, bestMax = s, m end
                    end
                end
                if best then
                    local key = nameOf(best)
                    local last = nil
                    for _, ob in ipairs(S.behemoths) do if ob.key == key then last = ob.last end end
                    behemoths[#behemoths + 1] = { set = best, key = key, last = last }
                end
            end
        end
    end
    S.behemoths = behemoths
    local summary = string.format("%s: %d behemoth(s)", S.role, #behemoths)
    if summary ~= S.lastSummary then S.lastSummary = summary log(summary) end
end

---------------------------------------------------------------- damage multiplier
-- every health drop on a behemoth is repeated (mult - 1) more times, never below 1 HP, so the game's own hit still
-- lands the kill
local function tick()
    if T.damage <= 1 then
        -- off: the last health is forgotten, so turning it on again never multiplies the damage dealt meanwhile
        for _, b in ipairs(S.behemoths) do b.last = nil end
        return
    end
    local now = os.clock()
    if now - lastRescan >= RESCAN_EVERY then rescan(now) end
    -- the hunt server owns the behemoth's health; your game only shows what it sends (multiplying there too would
    -- multiply the server's already multiplied drop again, on your screen)
    if not (S.roleKnown and S.role == "server") then return end
    for _, b in ipairs(S.behemoths) do
        if valid(b.set) then
            local hp = readNum(b.set, "CurrentHealth")
            if hp then
                if b.last and hp < b.last then
                    local want = math.max(1, hp - (b.last - hp) * (T.damage - 1))
                    if want < hp and writeNum(b.set, "CurrentHealth", want) then
                        logOnce("dmg", string.format("damage x%g working: behemoth %.0f -> %.0f (%s)", T.damage, hp, want, S.role))
                        hp = want
                    end
                end
                b.last = hp
            end
        end
    end
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
    local invs = playerInventories()
    if #invs == 0 then return end
    if not invFnsDone then
        invFns = discoverInvFns(invs[1])
        invFnsDone = true
        log("instant refresh candidates: " .. (#invFns > 0 and table.concat(invFns, ", ") or "none found"))
    end
    if not invFns or #invFns == 0 then return end
    local pick = nil
    if T.refreshFn ~= "" then
        for _, n2 in ipairs(invFns) do if n2 == T.refreshFn then pick = n2 end end
    end
    if not pick then
        pick = invFns[((nextFn - 1) % #invFns) + 1]
        nextFn = nextFn + 1
    end
    -- a game function: called on the game's thread, at its next event (6.8; this runs on the timer thread)
    PendingRefresh = { pick = pick, invs = invs }
    log("instant refresh: " .. pick .. " will be called at the game's next event")
end
-- on the game's thread only
function runPendingRefresh()
    local r = PendingRefresh
    if not r then return end
    PendingRefresh = nil
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
local TRACK_SCAN   = 1.0     -- seconds between searches for behemoths while tracking
local TRACK_PARTS  = 3.0     -- seconds between part searches for a behemoth that has none linked yet
local TRACK_REBIND = 10.0    -- seconds between part searches once found (a part actor can be replaced in a fight)
local TRACK_LINGER = 4.0     -- seconds a dead behemoth stays on the overlay
local TRACK_BEAT   = 1.0     -- seconds: rewrite the file this often even when nothing changed
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
local function partReader(actor, sets)
    local ap = pathOf(actor)
    local st = ap and healthSetUnder(sets, ap)
    if not st then return nil end
    logOnce("parthp:set", "overlay: part health read from its ArchonHealthAttributeSet")
    -- nil once the set is gone (a part actor replaced or destroyed): never a stale 0 that would read as "Broken"
    return function()
        if not valid(st) then return nil end
        return readNum(st, "CurrentHealth"), readNum(st, "MaxHealth")
    end, st
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
                local read, st = partReader(actor, sets)
                local raw = lastName(comp) or ""
                local id = nameOf(actor) or raw
                -- no health object right now (the game is replacing it): the part stays listed, its health unknown
                if not read then read = function() return nil end end
                if not seen[id] then
                    seen[id] = true
                    parts[#parts + 1] = { raw = raw, name = prettyPart(raw), read = read, set = st, actor = actor, comp = comp }
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

local function trackScan(now)
    Tk.lastScan = now
    if now - (Tk.psAt or -100) >= 5 then Tk.psAt = now Tk.playerStates = findAll({ "ArchonPlayerState" }) end
    local found = {}
    local bl = findAll({ "ArchonBehemoth" })
    local sets, comps = nil, nil
    for _, b in ipairs(bl) do
        local key = nameOf(b)
        if key then
            local e = Tk.list[key]
            if not e then
                sets = sets or findAll({ "ArchonHealthAttributeSet" })
                local path = pathOf(b)
                local st = path and healthSetUnder(sets, path)
                if st then
                    e = { key = key, b = b, path = path, set = st, cls = (key:match("^(%S+)") or ""), last = nil, at = nil,
                          parts = {}, partsAt = -100, partLast = {}, breaks = {}, broke = {} }
                    Tk.list[key] = e
                end
            end
            if e then
                found[key] = true
                if not e.gameName and (e.nameTries or 0) < 20 then
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
                -- the regular re-check is for the behemoth being fought; the others only until their parts are found
                local again = (#e.parts == 0 and now - e.partsAt >= TRACK_PARTS) or (e.at and now - e.partsAt >= TRACK_REBIND) or e.partsLost
                if S.roleKnown and S.role == "server" and again then   -- parts are read on hunt servers only
                    e.partsAt = now
                    sets = sets or findAll({ "ArchonHealthAttributeSet" })
                    comps = comps or findAll({ "MonsterPartComponent" })   -- one search per scan, shared by every behemoth
                    local ok, ps = pcall(findParts, e, sets, comps)
                    e.partsLost = false
                    if ok then
                        local was = {}
                        for _, p in ipairs(e.parts) do was[p.name] = p.actor end
                        for _, p in ipairs(ps) do
                            if was[p.name] and was[p.name] ~= p.actor and nameOf(was[p.name]) ~= nameOf(p.actor) then
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
    -- gone only when the behemoth object itself is gone (one search not listing it is not enough: dropping the entry
    -- would also drop which parts broke in this fight)
    for key, e in pairs(Tk.list) do if not found[key] and not valid(e.b) then Tk.list[key] = nil end end
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
    return function()
        if not valid(set) then return nil end
        return readNum(set, way[1]), readNum(set, way[2])
    end
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
        local sc, sm = e.stag()
        if sc and sm and sm > 0 then stg = string.format(',"stg":[%.0f,%.0f]', math.max(fin(sc), 0), fin(sm)) end
    end
    if e.stagDmg then stg = stg .. string.format(',"sdmg":%.0f', math.max(fin(e.stagDmg), 0)) end
    -- the game's own name for this behemoth, and its metadata row name (the panel prefers these to any mapping)
    if e.gameName then stg = stg .. ',"nm":"' .. tostring(e.gameName):gsub('[%c"\\]', '') .. '"' end
    if e.metaName then stg = stg .. ',"mn":"' .. tostring(e.metaName):gsub('[%c"\\]', '') .. '"' end
    if e.dispArch then stg = stg .. ',"da":"' .. tostring(e.dispArch):gsub('[%c"\\]', '') .. '"' end
    if e.dispClass and e.dispClass ~= "" then stg = stg .. ',"dc":"' .. tostring(e.dispClass):gsub('[%c"\\]', '') .. '"' end
    return string.format('{"key":"%s","cls":"%s","cur":%.0f,"max":%.0f,"at":%d,"n":%d,"dead":%s,"parts":[%s]%s}',
        clean(e.key), clean(e.cls), math.max(hp, 0), mx, e.atTime or 0, e.n or 0, tostring(dead), table.concat(ps, ","), stg)
end

local resolveBreak   -- defined with the break events below; called by the tracking loop
local function trackTick(now)
    if not T.track or not TrackFile then
        if not Tk.cleared and TrackFile then os.remove(TrackFile) Tk.cleared = true Tk.lastBody = nil end
        return
    end
    Tk.cleared = false
    -- your own game searches for behemoths only within 30 s of a hit (the hunt server tracks the fight; in town, where
    -- the game loads the most, it never searches); a hunt server searches every second
    local nearFight = S.role ~= "game" or (Tk.hitAt and now - Tk.hitAt < 30)
    if not InGT and nearFight and now - Tk.lastScan >= TRACK_SCAN then trackScan(now) end
    -- what dropped since last time: that behemoth becomes the one to show
    local best = nil
    for key, e in pairs(Tk.list) do
        if not valid(e.b) then Tk.list[key] = nil   -- despawned or a new encounter: its parts start fresh
        elseif not valid(e.set) then
            -- replaced by the game: looked for again (at most every 3 s; one search goes through every object)
            if now - (e.setAt or -100) >= TRACK_PARTS then e.setAt = now e.set = healthSetUnder(findAll({ "ArchonHealthAttributeSet" }), e.path) or e.set end
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
                    e.partLast[p.name] = c   -- a missing reading keeps the last real one for comparing
                    e.partLow = e.partLow or {}
                    local low = e.partLow[p.name]
                    if not low or c <= low.v or now - low.at > 1.5 then e.partLow[p.name] = { v = c, at = now } end
                end
            end
            if e.pending then local okR, errR = pcall(resolveBreak, e, now) if not okR then logOnce("resolve:" .. tostring(errR), "overlay: break check error: " .. tostring(errR)) e.pending = nil end end
            if hit then Tk.n = Tk.n + 1 e.at, e.atTime, e.n = now, os.time(), Tk.n end
            if hp and hp <= 0 and not e.deadAt then e.deadAt = now end
            if hp and hp > 0 then e.deadAt = nil end   -- 0 at spawn (health not filled in yet) is not dead
            if e.deadAt and now - e.deadAt > TRACK_LINGER then e.at = nil end
            if e.at and (not best or e.at > best.at) then best = e end
        end
    end
    local body = best and trackJson(best) or "null"
    if body == Tk.lastBody and now - Tk.lastWrite < TRACK_BEAT then return end
    local f = io.open(TrackFile, "w")
    if not f then logOnce("notrack", "cannot write " .. TrackFile .. " (the panel creates the track folder)") return end
    f:write(string.format('{"role":"%s","time":%d,"b":%s}', S.role, os.time(), body))
    f:close()
    if best and body ~= Tk.lastBody and not Tk.logged then Tk.logged = true log("overlay: tracking " .. best.cls .. " (" .. S.role .. ")") end
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
    local best = nil
    for _, e in pairs(Tk.list) do if e.at and (not best or e.at > best.at) then best = e end end
    if not best or not valid(best.b) then return end
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
        if not best.broke[p.name] and p.comp and valid(p.comp) then
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
    for _, e in pairs(Tk.list) do
        if e.at and now - e.at < 60 and valid(e.b) then partsBrokenIn(e) end
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
            before[p.name] = (low and now - low.at <= 1.5 and low.v) or e.partLast[p.name]
            if c == nil and e.partLast[p.name] ~= nil then gone[#gone + 1] = p end
        end
    end
    if #gone == 1 then markBroken(e, gone[1], why .. ", its health object removed") return end
    e.pending = { at = now, why = why, before = before }
end
-- called on every sample while a break is waiting to be identified
resolveBreak = function(e, now)
    local pb = e.pending
    if not pb then return end
    local best, bestRise = nil, 0
    for _, p in ipairs(e.parts) do
        if not e.broke[p.name] then
            local c, m = p.read()
            local b = pb.before[p.name]
            if c ~= nil and c <= 0 then markBroken(e, p, pb.why .. ", health 0") e.pending = nil return end
            if c ~= nil and b ~= nil and m and m > 0 then
                local rise = (c - b) / m
                if rise > bestRise then best, bestRise = p, rise end
            end
        end
    end
    local bc, bm = nil, nil
    if best then bc, bm = best.read() end
    if best and bestRise >= 0.1 and bc and bm and bc >= 0.9 * bm then
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

---------------------------------------------------------------- quest tracking (your game only, while it is on)
-- The game's quests are UQuest objects (status: EQuestStatus; data: a quest data asset with QuestType, Main / Side /
-- Special / Rumour, and its texts) with UObjective objects (current amount, amount required, status, description).
-- They are read from the game itself: nothing is guessed. Function calls (GetCurrentAmount, GetAmountRequired...) are
-- made only on the game's thread: from the game's own quest events (the in-game tracker's OnQuestObjectiveUpdated /
-- OnQuestStatusUpdated, which fire when progress or status changes) and hits. Between those, only properties are
-- read. A value the game does not give is left out, never filled in. What was found where is logged once.
local QuestFile = Base and (Base .. "/quests/" .. ProcId .. ".json")
local Qs = { list = nil, scanAt = -100, lastBody = nil, lastWrite = -100, dirty = true, gtAt = -100, cls = {}, enums = {}, static = {} }

local function jstr(v)   -- a JSON string (quotes, backslashes and control characters escaped; other text as is)
    return '"' .. tostring(v or ""):gsub('[%c"\\]', function(c)
        if c == '"' then return '\\"' elseif c == "\\" then return "\\\\" elseif c == "\n" then return " " end
        return ""
    end) .. '"'
end
local function textOf(v)
    if v == nil then return nil end
    if type(v) == "string" then return v end
    local ok, s = pcall(function() return v:ToString() end)
    if ok and type(s) == "string" then return s end
    return nil
end
local function numOf(v) if type(v) == "number" then return v end return nil end
local function okObj(v) return v ~= nil and type(v) ~= "number" and type(v) ~= "string" and type(v) ~= "boolean" and valid(v) end

-- an enum's value -> name ("EQuestStatus::Accepted" -> "Accepted"), from the game's own enum object
local function enumNames(path)
    if Qs.enums[path] ~= nil then return Qs.enums[path] end
    local map = false
    local okE, en = pcall(StaticFindObject, path)
    if okE and en and okObj(en) then
        local m, n = {}, 0
        pcall(function() en:ForEachName(function(name, value) local t = textOf(name) if t then m[value] = t:match("::(.+)$") or t n = n + 1 end end) end)
        if n == 0 then
            for v = 0, 12 do
                local okN, nm = pcall(function() return en:GetNameByValue(v) end)
                local t = okN and textOf(nm)
                if t and t ~= "" and t ~= "None" then m[v] = t:match("::(.+)$") or t n = n + 1 end
            end
        end
        if n > 0 then map = m end
    end
    Qs.enums[path] = map
    local parts = {}
    if map then for v, nm in pairs(map) do parts[#parts + 1] = v .. "=" .. nm end table.sort(parts) end
    log("quests: " .. path .. (map and (" " .. table.concat(parts, ",")) or " not found"))
    return map
end
local function enumName(path, v)
    if type(v) ~= "number" then return nil end
    local m = enumNames(path)
    return m and m[v] or nil
end

-- which properties a class has (names and kinds, read once per class: metadata only, no values), logged once
local function classInfo(o, what)
    local cls = (nameOf(o) or "?"):match("^(%S+)") or "?"
    local info = Qs.cls[cls]
    if info then return info end
    info = { props = {}, list = {} }
    for _, pr in ipairs(floatProps(o)) do
        if not info.props[pr.name] then info.props[pr.name] = pr.kind info.list[#info.list + 1] = pr.name .. ":" .. pr.kind end
    end
    Qs.cls[cls] = info
    log("quests: " .. what .. " " .. cls .. " has " .. table.concat(info.list, ", ", 1, math.min(#info.list, 90)))
    return info
end
local function firstProp(o, info, names, kinds)
    for _, n in ipairs(names) do
        local k = info.props[n]
        if k and (not kinds or kinds[k]) then
            local ok, v = pcall(getField, o, n)
            if ok and v ~= nil then return v, n end
        end
    end
    return nil
end
local NUM = { IntProperty = true, FloatProperty = true, Int64Property = true, UInt32Property = true, DoubleProperty = true, Int16Property = true }
local ENUM = { EnumProperty = true, ByteProperty = true }
local OBJ = { ObjectProperty = true, WeakObjectProperty = true }
-- a text property whose name says what it is (title first, then a short description)
local function textProp(o, info, wants)
    for _, w in ipairs(wants) do
        for _, entry in ipairs(info.list) do
            local n, k = entry:match("^(.-):(.+)$")
            if (k == "TextProperty" or k == "StrProperty") and n:lower():find(w, 1, true) and not n:lower():find("originator") and not n:lower():find("redeemer") and not n:lower():find("format") then
                local ok, v = pcall(getField, o, n)
                local t = ok and textOf(v)
                if t and t ~= "" then return t, n end
            end
        end
    end
    return nil
end
local function call(o, fn, gt) if not gt then return nil end local ok, v = pcall(callM, o, fn) if ok then return v end return nil end
local function arrayObjs(arr)
    local out = {}
    if arr == nil then return out end
    pcall(function() arr:ForEach(function(_, el) local o = el:get() if okObj(o) then out[#out + 1] = o end end) end)
    return out
end

-- one objective, read from the game. Fixed facts (description, amount required) are kept once found.
local function readObjective(o, gt)
    local key = nameOf(o) or tostring(o)
    local st = Qs.static[key] or {}
    Qs.static[key] = st
    local info = classInfo(o, "objective")
    local data = st.data
    if data == nil then
        data = firstProp(o, info, { "TheData", "ObjectiveData", "Data" }, OBJ)
        if not okObj(data) then data = call(o, "GetObjectiveData", gt) end
        if okObj(data) then st.data = data elseif gt then st.data = false end
    end
    local dinfo = okObj(st.data) and classInfo(st.data, "objective data") or nil
    -- the amount: the game's functions on its thread, else the replicated property
    local cur = numOf(call(o, "GetCurrentAmount", gt))
    if cur == nil then cur = numOf((firstProp(o, info, { "CurrentAmount" }, NUM))) end
    if st.req == nil then
        local r = numOf(call(o, "GetAmountRequired", gt))
        if r == nil then r = numOf((firstProp(o, info, { "AmountRequired", "RequiredAmount", "TargetAmount" }, NUM))) end
        if r == nil and dinfo then r = numOf((firstProp(st.data, dinfo, { "AmountRequired", "RequiredAmount", "TargetAmount", "ObjectiveAmount", "Amount" }, NUM))) end
        if r ~= nil then st.req = r end
    end
    local sv = numOf(call(o, "GetStatus", gt))
    if sv == nil then sv = numOf((firstProp(o, info, { "Status", "ObjectiveStatus" }, ENUM))) end
    local status = enumName("/Script/Archon.EObjectiveStatus", sv)
    -- between the game's events only properties can be read: what the game last said is kept until it says more
    if cur ~= nil then st.cur = cur else cur = st.cur end
    if status ~= nil then st.status = status else status = st.status end
    if st.hidden == nil then
        local h = call(o, "IsObjectiveHidden", gt)
        if type(h) == "boolean" then st.hidden = h end
    end
    if st.desc == nil then
        local d = dinfo and textProp(st.data, dinfo, { "description", "text", "name", "title" })
        if d then st.desc = d end
    end
    local done = status == "Completed" or (cur ~= nil and st.req ~= nil and st.req > 0 and cur >= st.req)
    return { desc = st.desc, cur = cur, req = st.req, done = done, status = status, hidden = st.hidden }
end

local function readQuest(q, gt)
    local info = classInfo(q, "quest")
    local key = nameOf(q) or tostring(q)
    local st = Qs.static[key] or {}
    Qs.static[key] = st
    local sv = numOf((firstProp(q, info, { "Status", "QuestStatus", "CurrentStatus" }, ENUM)))
    if sv == nil then sv = numOf(call(q, "GetStatus", gt)) end
    local status = enumName("/Script/Archon.EQuestStatus", sv)
    if status ~= nil then st.status = status elseif not gt then status = st.status end
    if status and status ~= "Accepted" and status ~= "Redeemable" then return nil end   -- only quests you are on
    if st.data == nil then
        local d = firstProp(q, info, { "QuestData" }, OBJ)
        if not okObj(d) then d = call(q, "GetQuestData", gt) end
        if okObj(d) then st.data = d elseif gt then st.data = false end
    end
    local dinfo = okObj(st.data) and classInfo(st.data, "quest data") or nil
    if st.type == nil and dinfo then
        local tv = numOf((firstProp(st.data, dinfo, { "QuestType" }, ENUM)))
        if tv ~= nil then st.type = enumName("/Script/Archon.EQuestType", tv) or false end
    end
    if st.title == nil then
        local t = dinfo and textProp(st.data, dinfo, { "title", "displayname", "questname" })
        if not t then t = textOf(call(q, "GetSerieTitle", gt)) end
        if not t and dinfo then t = textProp(st.data, dinfo, { "shortdescription" }) end
        if t and t ~= "" then st.title = t end
    end
    if st.id == nil then
        local id = textOf(call(q, "GetID", gt))
        if id and id ~= "" and id ~= "None" then st.id = id end
    end
    -- its objectives: the quest's own list, else the objective objects inside it
    local objs = arrayObjs(firstProp(q, info, { "Objectives", "CurrentObjectives" }, { ArrayProperty = true }))
    if #objs == 0 and st.objPaths then
        for _, o in ipairs(st.objPaths) do if valid(o) then objs[#objs + 1] = o end end
    end
    if #objs == 0 and (st.objScanAt or -100) < Qs.scanAt then
        st.objScanAt = Qs.scanAt
        local qp = pathOf(q)
        local found = {}
        for _, o in ipairs(Qs.allObjectives or {}) do if under(pathOf(o), qp) then found[#found + 1] = o end end
        st.objPaths = found
        objs = found
    end
    local list, allDone, any = {}, true, false
    for _, o in ipairs(objs) do
        local r = readObjective(o, gt)
        if not r.hidden then
            if r.status == "InProgress" or r.status == "Completed" then any = true end
            if not r.done then allDone = false end
            list[#list + 1] = r
        end
    end
    -- quest status not readable: a quest counts as one you are on only if the game reports one of its objectives as
    -- in progress or completed (a quest not yet accepted has objectives "NotStarted")
    if not status then
        if not any then return nil end
        status = allDone and "Redeemable" or "Accepted"
    end
    return { key = key, id = st.id, title = st.title, type = st.type or nil, status = status, objs = list }
end

local function questScan(now)
    Qs.scanAt = now
    local all = findAll({ "Quest" })
    -- your own quests: those under your player controller (or player state) when the game keeps them there
    local pc
    for _, c in ipairs(findAll(PC_CLASSES)) do if isLocal(c) then pc = c break end end
    local mine = {}
    if pc then
        local roots = { pathOf(pc) }
        local okS, ps = pcall(getField, pc, "PlayerState")
        if okS and okObj(ps) then roots[#roots + 1] = pathOf(ps) end
        for _, q in ipairs(all) do
            local qp = pathOf(q)
            for _, r in ipairs(roots) do if under(qp, r) then mine[#mine + 1] = q break end end
        end
    end
    Qs.list = #mine > 0 and mine or all
    Qs.allObjectives = nil
    for _, q in ipairs(Qs.list) do
        local info = classInfo(q, "quest")
        if not info.props.Objectives then Qs.allObjectives = findAll({ "Objective" }) break end
    end
    logOnce("qscan", string.format("quests: %d quest objects (%d under your player)", #all, #mine))
end

local function questTick(now, gt)
    if not T.quests or S.role ~= "game" or not QuestFile then
        if Qs.lastBody and QuestFile then os.remove(QuestFile) Qs.lastBody = nil end
        return
    end
    if not Qs.list or now - Qs.scanAt >= 5 or (Qs.dirty and now - Qs.scanAt >= 1) then questScan(now) end
    Qs.dirty = false
    local out = {}
    for _, q in ipairs(Qs.list or {}) do
        if valid(q) then
            local ok, r = pcall(readQuest, q, gt)
            if ok and r then
                local os_ = {}
                for _, o in ipairs(r.objs) do
                    os_[#os_ + 1] = string.format('{"d":%s,"c":%s,"r":%s,"done":%s}', jstr(o.desc),
                        o.cur and string.format("%.0f", fin(o.cur)) or "null", o.req and string.format("%.0f", fin(o.req)) or "null", tostring(o.done))
                end
                out[#out + 1] = string.format('{"key":%s,"id":%s,"title":%s,"type":%s,"status":%s,"obj":[%s]}', jstr(r.key), jstr(r.id),
                    jstr(r.title), jstr(r.type), jstr(r.status), table.concat(os_, ","))
            elseif not ok then logOnce("qerr:" .. tostring(r), "quests: " .. tostring(r)) end
        end
    end
    table.sort(out)
    local body = "[" .. table.concat(out, ",") .. "]"
    if body == Qs.lastBody and now - Qs.lastWrite < 2 then return end
    local f = io.open(QuestFile, "w")
    if not f then logOnce("noquests", "cannot write " .. QuestFile .. " (the panel creates the quests folder)") return end
    f:write(string.format('{"role":"%s","time":%d,"gt":%s,"q":%s}', S.role, os.time(), tostring(gt), body))
    f:close()
    if body ~= Qs.lastBody then logOnce("qfirst", "quests: tracking " .. #out .. " active quest(s)") end
    Qs.lastBody, Qs.lastWrite = body, now
end
-- on the game's thread (quest events, hits): functions allowed; at most 4 times a second
local function questGameThread()
    if not T.quests or S.role ~= "game" then return end
    local now = os.clock()
    if now - Qs.gtAt < 0.25 then Qs.dirty = true return end
    Qs.gtAt = now
    Qs.dirty = true
    local ok, err = pcall(questTick, now, true)
    if not ok then logOnce("qgt:" .. tostring(err), "quests error: " .. tostring(err)) end
end

---------------------------------------------------------------- status heartbeat for the panel
local lastStatus, lastRead = -100, -100
local function writeStatus(now)
    lastStatus = now
    if not StatusFile then return end
    local f = io.open(StatusFile, "w")
    if not f then logOnce("nostatus", "cannot write " .. StatusFile .. " (the panel creates the status folder when it installs the mod)") return end
    local fns = invFns and table.concat({ table.unpack(invFns, 1, math.min(#invFns, 6)) }, ",") or ""
    f:write(string.format('{"v":"%s","role":"%s","time":%d,"behemoths":%d,"damage":%g,"invFns":"%s","called":"%s","calledAt":%d}',
        MOD_VERSION, S.role, os.time(), #S.behemoths, T.damage, clean(fns), clean(S.called or ""), S.calledAt or 0))
    f:close()
end

---------------------------------------------------------------- loop
local function step()
    local now = os.clock()
    if now - lastRead >= READ_EVERY then
        lastRead = now
        readToggles()
        if T.refresh and now - lastRescan >= RESCAN_EVERY and T.damage <= 1 then rescan(now) end
        pcall(checkRefresh)
    end
    local ok, err = pcall(tick)
    if not ok then logOnce("tick:" .. tostring(err), "tick error: " .. tostring(err)) end
    if T.quests and now - (Qs.timerAt or -100) >= 1 then
        Qs.timerAt = now
        local okQ, errQ = pcall(questTick, now, false)
        if not okQ then logOnce("quest:" .. tostring(errQ), "quests error: " .. tostring(errQ)) end
    elseif not T.quests and Qs.lastBody then pcall(questTick, now, false) end
    local okT, errT = pcall(trackTick, now)
    if not okT then logOnce("track:" .. tostring(errT), "overlay error: " .. tostring(errT)) end
    if now - lastStatus >= STATUS_EVERY then
        -- role only, until it is known to be your game (a game never becomes a server)
        if T.damage <= 1 and not T.refresh and S.role ~= "game" and now - lastRescan >= 10 then pcall(rescan, now) end
        pcall(writeStatus, now)
    end
end

LoopAsync(TICK_MS, function()
    local ok, err = pcall(step)
    if not ok then logOnce("step:" .. tostring(err), "loop error: " .. tostring(err)) end
    return false
end)

-- a hit lands: the multiplier and the overlay answer at once, on the game's own thread (only while one of them is on)
-- Repeaters land many hits a second: the multiplier answers each (30 a second at most), the overlay 8 a second at
-- most (it reads every part and writes a file, so not on every bullet)
local lastHitTick, lastHitTrack = -1, -1
local hooked, hookErr = pcall(function()
    RegisterHook("/Script/Archon.ArchonCombatTextComponent:MulticastSendMultitypeCombatText", function()
        if PendingRefresh then onGameThread(function() end) end   -- an instant refresh waiting for the game's thread
        if T.damage <= 1 and not T.track and not T.quests then return end
        local now = os.clock()
        Tk.hitAt = now
        if T.damage > 1 and now - lastHitTick >= 0.03 then lastHitTick = now onGameThread(tick) end
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

-- the game's own quest events (they fire when a quest's progress or status changes, and when quests arrive): the
-- quest tracker reads then, on the game's thread. Each returns at once while the tracker is off.
local qHooks = {}
for _, fn in ipairs({ "/Script/Archon.HUDObjectiveTracker:OnQuestObjectiveUpdated", "/Script/Archon.HUDObjectiveTracker:OnQuestStatusUpdated",
                      "/Script/Archon.MarkerSystemComponent:OnQuestObjectiveUpdated", "/Script/Archon.MarkerSystemComponent:OnQuestStatusUpdated",
                      "/Script/Archon.QuestSystemComponent:OnRep_Series", "/Script/Archon.QuestSystemComponent:OnRep_NumExpectedQuests" }) do
    local ok = pcall(RegisterHook, fn, function() if T.quests then onGameThread(questGameThread) elseif PendingRefresh then onGameThread(function() end) end end)
    if ok then qHooks[#qHooks + 1] = fn:match(":(.+)$") end
end
log("quest events hooked: " .. (#qHooks > 0 and table.concat(qHooks, ", ") or "none (the tracker reads every second instead)"))

log("loaded (v" .. MOD_VERSION .. ": damage multiplier, overlay tracking with stagger and broken parts, quest tracker, instant refresh)")
