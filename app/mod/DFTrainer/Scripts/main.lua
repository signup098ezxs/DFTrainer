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

local function valid(o)
    if not o then return false end
    local ok, v = pcall(function() return o:IsValid() end)
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
    local ok, v = pcall(function() return o[prop] end)
    if ok and type(v) == "number" then return v end
    return nil
end
local function writeNum(o, prop, v)
    local ok = pcall(function() o[prop] = v end)
    return ok
end
local function under(objPath, ownerPath)
    return objPath and ownerPath and objPath:sub(1, #ownerPath + 1) == ownerPath .. "."
end
local function findAll(classes)
    local out, seen = {}, {}
    for _, cls in ipairs(classes) do
        local ok, list = pcall(FindAllOf, cls)
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
local T = { damage = 1, refresh = false, refreshFn = "", locked = false, track = false, lock = false, lockPart = "Head", lockSmooth = 0.15 }
local togglesText = ""

local function parseToggles(s)
    local function flag(k) return s:find('"' .. k .. '"%s*:%s*true') ~= nil end
    T.damage  = math.max(1, math.min(1000, tonumber(s:match('"damage"%s*:%s*(%-?[%d%.]+)')) or 1))
    T.refresh = flag("refresh")
    T.refreshFn = s:match('"refreshFn"%s*:%s*"([%w_]*)"') or ""
    T.locked = flag("locked")   -- not the owner's panel: no multiplier, no refresh
    if T.locked then T.damage, T.refresh = 1, false end
    T.track = flag("track")     -- the behemoth overlay is on (anyone's panel)
    -- part lock-on (Repeaters only; the owner's, like Damage)
    T.lock = flag("lock") and not T.locked
    T.lockPart = s:match('"lockPart"%s*:%s*"([%w _]*)"') or "Head"
    T.lockSmooth = math.max(0.02, math.min(0.6, tonumber(s:match('"lockSmooth"%s*:%s*([%d%.]+)')) or 0.15))
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
        log(string.format("toggles: damage=x%g refresh=%s track=%s lock=%s (%s, smooth %.2f)", T.damage, tostring(T.refresh), tostring(T.track), tostring(T.lock), T.lockPart, T.lockSmooth))
    end
end

---------------------------------------------------------------- what is in this process
local S = { role = "server", behemoths = {}, owners = {} }
local lastRescan = -100

-- your game is the only copy with a local player (your screen and keyboard); server copies only have remote
-- controllers. IsLocalController alone does not answer in every copy (3.3.x took your game for a server and let it
-- look for parts), so the local player objects decide too, as in the first versions of this mod.
local function isLocal(pc)
    local ok, res = pcall(function() return pc:IsLocalController() end)
    if ok and res == true then return true end
    local okP, pl = pcall(function() return pc.Player end)
    if not (okP and valid(pl)) then return false end
    local n = (nameOf(pl) or ""):lower()
    return n:find("localplayer", 1, true) ~= nil or n:find("local_player", 1, true) ~= nil
end
local function hasLocalPlayer()
    for _, cls in ipairs({ "ArchonLocalPlayer", "LocalPlayer" }) do
        local ok, list = pcall(FindAllOf, cls)
        for _, lp in ipairs(ok and list or {}) do
            local n = nameOf(lp) or ""
            if valid(lp) and not n:find("Default__", 1, true) then return true end
        end
    end
    return false
end

-- behemoths and their health sets; players only when instant refresh needs their inventories
local function rescan(now)
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
        local okB, blist = pcall(FindAllOf, "ArchonBehemoth")
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
    if T.damage <= 1 then return end
    local now = os.clock()
    if now - lastRescan >= RESCAN_EVERY then rescan(now) end
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
    local ok, list = pcall(FindAllOf, "ArchonInventory")
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
    for _, inv in ipairs(invs) do
        local okC, err = pcall(function() return inv[pick](inv) end)
        if not okC then logOnce("callerr:" .. pick, "calling " .. pick .. " failed: " .. tostring(err)) end
    end
    S.called, S.calledAt = pick, os.time()
    log("instant refresh: called " .. pick .. " on " .. #invs .. " inventory object(s)")
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
                if read and not seen[id] then
                    seen[id] = true
                    parts[#parts + 1] = { raw = raw, name = prettyPart(raw), read = read, set = st, actor = actor }
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
                          parts = {}, partsAt = -100, partLast = {}, breaks = {} }
                    Tk.list[key] = e
                end
            end
            if e then
                found[key] = true
                -- the regular re-check is for the behemoth being fought; the others only until their parts are found
                local again = (#e.parts == 0 and now - e.partsAt >= TRACK_PARTS) or (e.at and now - e.partsAt >= TRACK_REBIND) or e.partsLost
                if S.roleKnown and S.role == "server" and again then   -- parts are read on hunt servers only
                    e.partsAt = now
                    sets = sets or findAll({ "ArchonHealthAttributeSet" })
                    comps = comps or findAll({ "MonsterPartComponent" })   -- one search per scan, shared by every behemoth
                    local ok, ps = pcall(findParts, e, sets, comps)
                    e.partsLost = false
                    if ok then
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
    for key in pairs(Tk.list) do if not found[key] then Tk.list[key] = nil end end
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
    local hp, mx = readNum(e.set, "CurrentHealth") or 0, readNum(e.set, "MaxHealth") or 0
    local ps = {}
    for _, p in ipairs(e.parts) do
        local c, m = p.read()
        if c == nil then e.partsLost = true end
        -- "Body" has millions of health (far more than the behemoth): not a part you can break, so it is not shown
        if c and m and m > 0 and not (mx > 0 and m > mx) then
            ps[#ps + 1] = string.format('["%s",%.0f,%.0f,%d]', clean(p.name), math.max(c, 0), m, e.breaks[p.name] or 0)
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
        stg = string.format(',"stg":[%.0f,%.0f]', math.max(e.stagFn[1], 0), e.stagFn[2])
    elseif e.stag then
        local sc, sm = e.stag()
        if sc and sm and sm > 0 then stg = string.format(',"stg":[%.0f,%.0f]', math.max(sc, 0), sm) end
    end
    return string.format('{"key":"%s","cls":"%s","cur":%.0f,"max":%.0f,"at":%d,"n":%d,"dead":%s,"parts":[%s]%s}',
        clean(e.key), clean(e.cls), math.max(hp, 0), mx, e.atTime or 0, e.n or 0, tostring(hp <= 0), table.concat(ps, ","), stg)
end

local function trackTick(now)
    if not T.track or not TrackFile then
        if not Tk.cleared and TrackFile then os.remove(TrackFile) Tk.cleared = true Tk.lastBody = nil end
        return
    end
    Tk.cleared = false
    if now - Tk.lastScan >= TRACK_SCAN then trackScan(now) end
    -- what dropped since last time: that behemoth becomes the one to show
    local best = nil
    for key, e in pairs(Tk.list) do
        if not valid(e.b) or not valid(e.set) then Tk.list[key] = nil
        else
            local hp = readNum(e.set, "CurrentHealth")
            local hit = hp and e.last and hp < e.last - 0.01
            if hp then e.last = hp end
            for _, p in ipairs(e.parts) do
                local c, m = p.read()
                local was = e.partLast[p.name]
                if c and was and c < was - 0.01 then hit = true end
                -- a break: the game often refills that part right away (it can break again), so breaks are counted
                if c and was and was > 0 and c <= 0 then e.breaks[p.name] = (e.breaks[p.name] or 0) + 1 end
                if c and was and ((was > 0 and c <= 0) or (was <= 0 and c > 0)) then
                    log(string.format("overlay: %s %s %s (%.0f/%s)", e.cls, p.name, c <= 0 and "broke" or "back", c, tostring(m)))
                end
                e.partLast[p.name] = c
            end
            if hit then Tk.n = Tk.n + 1 e.at, e.atTime, e.n = now, os.time(), Tk.n end
            if hp and hp <= 0 and not e.deadAt then e.deadAt = now end
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
local stagFnOk = nil
local function stagFromFunctions()
    if stagFnOk == false then return end
    local best = nil
    for _, e in pairs(Tk.list) do if e.at and (not best or e.at > best.at) then best = e end end
    if not best or not valid(best.b) then return end
    local okC, c, okM, m
    for _, o in ipairs({ best.b, best.set }) do
        if valid(o) then
            okC, c = pcall(function() return o:GetCurrentStaggerHealth() end)
            okM, m = pcall(function() return o:GetMaxStaggerHealth() end)
            if okC and okM and type(c) == "number" and type(m) == "number" then break end
        end
    end
    if okC and okM and type(c) == "number" and type(m) == "number" then
        if stagFnOk == nil then stagFnOk = true log(string.format("overlay: stagger from GetCurrentStaggerHealth/GetMaxStaggerHealth (%.0f/%.0f)", c, m)) end
        best.stagFn = { c, m }
    elseif stagFnOk == nil then
        stagFnOk = false
        log("overlay: no stagger functions on " .. best.cls .. " (" .. tostring(c) .. ")")
    end
end

---------------------------------------------------------------- part lock-on (Repeaters only)
-- Keeps your aim on one part of the behemoth (its head, a leg...) while you hold Repeaters: middle mouse (or F7) locks
-- and lets go, F8 picks the next part. Your game only. Every frame it asks where the part is now and turns your aim
-- part of the way there (the smoothness setting), so it follows the part as the behemoth moves, never snaps. It lets
-- go by itself when you put the Repeaters away, the part is destroyed, the behemoth dies or leaves, or it is far away.
-- Positions, the camera and the aim come from the game's own functions, called only on the game's thread: from a
-- per-frame event of the game (the one that really fires each frame is picked at run time), or a hit as a fallback.
local LK = { engaged = false, why = "", part = "", hooks = false, counts = {}, src = nil, srcAt = nil, lastFrame = 0,
             pc = nil, pcAt = -100, weapon = nil, weaponAt = -100, weaponOk = false, beh = nil, comp = nil, actor = nil, method = nil,
             parts = nil, changed = false }
local LOCK_RANGE = 15000   -- 150 m

local function vec(v)
    if v == nil then return nil end
    local ok, x, y, z = pcall(function() return v.X, v.Y, v.Z end)
    if ok and type(x) == "number" then return x, y, z end
    return nil
end
local function lockStatus(engaged, why)
    if LK.engaged ~= engaged or LK.why ~= why then
        LK.engaged, LK.why, LK.changed = engaged, why, true
        log("lock-on: " .. (engaged and ("on " .. LK.part) or ("off" .. (why ~= "" and (" (" .. why .. ")") or ""))))
    end
end
-- letting go always ends the lock: switching weapons, a part or behemoth gone... the key locks again
local function release(why)
    LK.beh, LK.comp, LK.actor, LK.parts, LK.want, LK.wy = nil, nil, nil, nil, false, nil
    lockStatus(false, why or "")
end

local function localPC(now)
    if LK.pc and valid(LK.pc) and now - LK.pcAt < 2 then return LK.pc end
    LK.pcAt = now
    LK.pc = nil
    for _, pc in ipairs(findAll(PC_CLASSES)) do if isLocal(pc) then LK.pc = pc break end end
    return LK.pc
end

-- Repeaters out? Your character's ArchonWeapon actors (owned by your character), WeaponType 6 = WeaponType_DP
-- (EWeaponType: NONE, IHAMMER, GAXE, EBLADE, CBLADES, MSPEAR, DP, AC, BOW), the one that is not hidden.
local weaponsLogged = false
local function repeatersOut(pawn, now)
    if now - LK.weaponAt < 0.15 then return LK.weaponOk end
    LK.weaponAt = now
    -- the weapon in hand, from the game itself (GetCurrentWeapon / GetWeaponType)
    local okW, cur = pcall(function() return pawn:GetCurrentWeapon() end)
    if okW and cur ~= nil and type(cur) ~= "number" and valid(cur) then
        local wt = readNum(cur, "WeaponType")
        if wt == nil then
            local okT, t = pcall(function() return cur:GetWeaponType() end)
            if okT and type(t) == "number" then wt = t end
        end
        local cls = ((nameOf(cur) or ""):match("^(%S+)") or ""):lower()
        if not weaponsLogged then weaponsLogged = true log("lock-on: weapon in hand: " .. cls .. " type=" .. tostring(wt)) end
        if wt ~= nil or cls ~= "" then
            LK.weaponOk = wt == 6 or (wt == nil and (cls:find("_dp_", 1, true) ~= nil or cls:find("repeater", 1, true) ~= nil))
            return LK.weaponOk
        end
    end
    local ok, found = false, {}
    for _, w in ipairs(findAll({ "ArchonWeapon" })) do
        local okO, owner = pcall(function() return w.Owner end)
        if okO and owner and valid(owner) and nameOf(owner) == nameOf(pawn) then
            local cls = ((nameOf(w) or ""):match("^(%S+)") or ""):lower()
            local wt = readNum(w, "WeaponType")
            local okH, hidden = pcall(function() return w.bHidden end)
            hidden = okH and hidden == true
            found[#found + 1] = cls .. " type=" .. tostring(wt) .. (hidden and " hidden" or "")
            local dp = wt == 6 or (wt == nil and (cls:find("_dp_", 1, true) or cls:find("repeater", 1, true)))
            if dp and not hidden then ok = true end
        end
    end
    if not weaponsLogged and #found > 0 then weaponsLogged = true log("lock-on: your weapons: " .. table.concat(found, ", ")) end
    LK.weaponOk = ok
    return ok
end

local function locOf(o)
    local okL, v = pcall(function() return o:K2_GetActorLocation() end)
    if okL then return vec(v) end
    return nil
end
-- where the part is right now: the part component's own position if it is a scene component (it moves with the
-- bone), else its part actor's
local function partPos(comp, actor)
    if LK.method ~= "actor" then
        local ok, v = pcall(function() return comp:K2_GetComponentLocation() end)
        local x, y, z = nil, nil, nil
        if ok then x, y, z = vec(v) end
        if x then
            if not LK.method then LK.method = "component" log("lock-on: part positions from the part component") end
            return x, y, z
        end
    end
    if actor and valid(actor) then
        local x, y, z = locOf(actor)
        if x then
            if LK.method ~= "actor" then LK.method = "actor" log("lock-on: part positions from the part actor") end
            return x, y, z
        end
    end
    return nil
end

local function behemothParts(beh)
    local list = {}
    local bp = pathOf(beh)
    for _, comp in ipairs(findAll({ "MonsterPartComponent" })) do
        if under(pathOf(comp), bp) then
            local name = prettyPart(lastName(comp))
            if name ~= "Body" then list[#list + 1] = { name = name, comp = comp, actor = linkedActor(comp) } end
        end
    end
    table.sort(list, function(a, b) return a.name < b.name end)
    return list
end

-- the behemoth to lock onto: the one you hit last (overlay tracking), else the one nearest the middle of your view
local function pickBehemoth(cx, cy, cz, yaw, pitch)
    local best, bestScore = nil, 1e30
    for _, e in pairs(Tk.list) do if e.at and valid(e.b) and (not best or e.at > bestScore) then best, bestScore = e.b, e.at end end
    if best then return best end
    local fx, fy, fz = math.cos(math.rad(pitch)) * math.cos(math.rad(yaw)), math.cos(math.rad(pitch)) * math.sin(math.rad(yaw)), math.sin(math.rad(pitch))
    bestScore = -2
    for _, b in ipairs(findAll({ "ArchonBehemoth" })) do
        local x, y, z = locOf(b)
        if x then
            local dx, dy, dz = x - cx, y - cy, z - cz
            local d = math.sqrt(dx * dx + dy * dy + dz * dz)
            if d > 0 and d < LOCK_RANGE then
                local dot = (dx * fx + dy * fy + dz * fz) / d
                if dot > bestScore then best, bestScore = b, dot end
            end
        end
    end
    return best
end

local function normAngle(a) a = (a + 180) % 360 if a < 0 then a = a + 360 end return a - 180 end

local function lockFrame(now, dt)
    local pc = localPC(now)
    if not pc then return release("no player") end
    local okP, pawn = pcall(function() return pc.Pawn end)
    if not (okP and valid(pawn)) then return release("no character") end
    if not repeatersOut(pawn, now) then return release("Repeaters only") end
    local okM, pcm = pcall(function() return pc.PlayerCameraManager end)
    local cx, cy, cz
    if okM and valid(pcm) then
        local okC, v = pcall(function() return pcm:GetCameraLocation() end)
        if okC then cx, cy, cz = vec(v) end
    end
    if not cx then return release("no camera") end
    local okR, rot = pcall(function() return pc:GetControlRotation() end)
    local pitch, yaw, roll
    if okR and rot then pcall(function() pitch, yaw, roll = rot.Pitch, rot.Yaw, rot.Roll end) end
    if type(yaw) ~= "number" then return release("no aim") end
    if not LK.beh or not valid(LK.beh) then
        LK.beh = pickBehemoth(cx, cy, cz, yaw, pitch)
        if not LK.beh then return release("no behemoth") end
        LK.parts = behemothParts(LK.beh)
        LK.comp, LK.actor = nil, nil
        local want = LK.part:lower()
        for _, p in ipairs(LK.parts) do if p.name:lower() == want then LK.comp, LK.actor = p.comp, p.actor end end
        if not LK.comp then   -- "Head" on a behemoth with "Head left" / "Head right": the first of those
            for _, p in ipairs(LK.parts) do if p.name:lower():find(want, 1, true) then LK.comp, LK.actor, LK.part = p.comp, p.actor, p.name break end end
        end
        if not LK.comp then return release(LK.part .. " not on this behemoth") end
    end
    if not valid(LK.comp) or (LK.actor and not valid(LK.actor)) then return release(LK.part .. " destroyed") end
    local e = Tk.list[nameOf(LK.beh) or ""]
    if e and e.last and e.last <= 0 then return release("behemoth defeated") end
    local tx, ty, tz = partPos(LK.comp, LK.actor)
    if not tx then return release("part lost") end
    local dx, dy, dz = tx - cx, ty - cy, tz - cz
    local flat = math.sqrt(dx * dx + dy * dy)
    if flat + math.abs(dz) > LOCK_RANGE * 1.2 then return release("too far") end
    local wantYaw = math.deg(math.atan(dy, dx))
    local wantPitch = math.deg(math.atan(dz, flat))
    -- how fast the part is crossing your view (smoothed): aiming that far ahead takes out the trailing a smooth
    -- follow would otherwise have when the behemoth runs or swings, without adding any snap
    local tau = T.lockSmooth
    local h = math.min(dt, 0.1)
    if LK.wy and LK.part == LK.ratePart then
        local ry, rp = normAngle(wantYaw - LK.wy) / h, (wantPitch - LK.wp) / h
        -- a jump no behemoth can make (a teleport, a part swap): not motion, so no lead from it
        if math.abs(ry) > 360 or math.abs(rp) > 240 then ry, rp = 0, 0 end
        local a = 1 - math.exp(-h / 0.12)
        LK.ry, LK.rp = LK.ry + (ry - LK.ry) * a, LK.rp + (rp - LK.rp) * a
    else LK.ry, LK.rp = 0, 0 end
    LK.wy, LK.wp, LK.ratePart = wantYaw, wantPitch, LK.part
    local leadY = math.max(-30, math.min(30, LK.ry * tau))
    local leadP = math.max(-15, math.min(15, LK.rp * tau))
    -- part of the way there each frame: the same feel at any frame rate (smoothness = time to close ~63%)
    local k = 1 - math.exp(-h / tau)
    local newYaw = yaw + normAngle(wantYaw + leadY - yaw) * k
    local newPitch = normAngle(pitch) + (wantPitch + leadP - normAngle(pitch)) * k
    newPitch = math.max(-85, math.min(85, newPitch))
    local okS, err = pcall(function() pc:SetControlRotation({ Pitch = newPitch, Yaw = newYaw, Roll = roll or 0 }) end)
    if not okS then logOnce("setrot", "lock-on: could not turn the aim: " .. tostring(err)) return release("aim blocked") end
    lockStatus(true, "")
end

-- the per-frame event: of the candidates that fire steadily (20+ times a second) the first in LK.order is kept
-- (your controller's or character's own tick before the busier engine-wide ones), the others are unhooked
LK.order, LK.ids = {}, {}
local function onFrame(src)
    if LK.src and src ~= LK.src then return end
    local now = os.clock()
    if not LK.src then
        LK.counts[src] = (LK.counts[src] or 0) + 1
        LK.srcAt = LK.srcAt or now
        if now - LK.srcAt >= 1.5 then
            local span = now - LK.srcAt
            for _, fn in ipairs(LK.order) do
                if (LK.counts[fn] or 0) / span >= 20 then LK.src = fn break end
            end
            if LK.src then
                log(string.format("lock-on: following frames through %s (%.0f a second)", LK.src, LK.counts[LK.src] / span))
                for fn, ids in pairs(LK.ids) do
                    if fn ~= LK.src and UnregisterHook then pcall(UnregisterHook, fn, ids[1], ids[2]) end
                end
            else LK.srcAt, LK.counts = now, {} end
        end
        if src ~= LK.src and src ~= "hit" then return end
    end
    if not (T.lock and LK.want) then return end
    local dt = now - LK.lastFrame
    if dt < 0.006 then return end
    LK.lastFrame = now
    local ok, err = pcall(lockFrame, now, dt)
    if not ok then logOnce("lockframe:" .. tostring(err), "lock-on error: " .. tostring(err)) release("error") end
end

local function lockHooks()
    if LK.hooks then return end
    LK.hooks = true
    local tries = {}
    local pc = localPC(os.clock())
    for _, o in ipairs({ pc, pc and (function() local ok, p = pcall(function() return pc.Pawn end) return ok and p or nil end)() }) do
        if o and valid(o) then
            local okC, c = pcall(function() return o:GetClass() end)
            local full = okC and nameOf(c)
            local path = full and full:match("^%S+%s+(.+)$")
            if path and path:sub(1, 6) == "/Game/" then tries[#tries + 1] = path .. ":ReceiveTick" end
        end
    end
    tries[#tries + 1] = "/Script/UMG.UserWidget:Tick"
    tries[#tries + 1] = "/Script/Engine.AnimInstance:BlueprintUpdateAnimation"
    for _, fn in ipairs(tries) do
        local ok, a, b = pcall(RegisterHook, fn, function() onFrame(fn) end)
        if ok then LK.order[#LK.order + 1] = fn LK.ids[fn] = { a, b } end
        log("lock-on: frame event " .. fn .. (ok and " hooked" or (" not available (" .. tostring(a) .. ")")))
    end
end

-- what the panel shows: whether it is locked, on what, or why not
local function lockJson()
    return string.format('"lock":{"on":%s,"want":%s,"engaged":%s,"part":"%s","why":"%s","frames":"%s","weapon":%s,"parts":"%s"}',
        tostring(T.lock), tostring(LK.want == true), tostring(LK.engaged), clean(LK.part), clean(LK.why), clean(LK.src or ""),
        tostring(LK.weaponOk), clean(table.concat((function() local t = {} for _, p in ipairs(LK.parts or {}) do t[#t + 1] = p.name end return t end)(), ",")))
end

local function lockToggle()
    if S.role ~= "game" or not T.lock then return end
    LK.want = not LK.want
    LK.part, LK.panelPart = T.lockPart, T.lockPart
    if LK.want then lockHooks() lockStatus(false, "looking for " .. LK.part) else release("let go") end
    LK.changed = true
end
local function lockNextPart()
    if S.role ~= "game" or not T.lock or not LK.parts or #LK.parts == 0 then return end
    local i = 1
    for j, p in ipairs(LK.parts) do if p.name == LK.part then i = j % #LK.parts + 1 end end
    LK.part, LK.comp, LK.actor = LK.parts[i].name, LK.parts[i].comp, LK.parts[i].actor
    LK.changed = true
    log("lock-on: part " .. LK.part)
end

---------------------------------------------------------------- status heartbeat for the panel
local lastStatus, lastRead = -100, -100
local function writeStatus(now)
    lastStatus = now
    if not StatusFile then return end
    local f = io.open(StatusFile, "w")
    if not f then logOnce("nostatus", "cannot write " .. StatusFile .. " (the panel creates the status folder when it installs the mod)") return end
    local fns = invFns and table.concat({ table.unpack(invFns, 1, math.min(#invFns, 6)) }, ",") or ""
    f:write(string.format('{"role":"%s","time":%d,"behemoths":%d,"damage":%g,"invFns":"%s","called":"%s","calledAt":%d,%s}',
        S.role, os.time(), #S.behemoths, T.damage, clean(fns), clean(S.called or ""), S.calledAt or 0, lockJson()))
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
    local okT, errT = pcall(trackTick, now)
    if not okT then logOnce("track:" .. tostring(errT), "overlay error: " .. tostring(errT)) end
    if LK.want and not T.lock then release("turned off") end
    -- another part picked in the panel while locked: move to it
    if LK.want and T.lockPart ~= LK.panelPart then
        LK.panelPart, LK.part, LK.beh, LK.changed = T.lockPart, T.lockPart, nil, true
        log("lock-on: part " .. LK.part .. " (from the panel)")
    end
    if now - lastStatus >= STATUS_EVERY or LK.changed then
        if T.damage <= 1 and not T.refresh and now - lastRescan >= 10 then pcall(rescan, now) end   -- role only
        LK.changed = false
        pcall(writeStatus, now)
    end
end

LoopAsync(TICK_MS, function()
    local ok, err = pcall(step)
    if not ok then logOnce("step:" .. tostring(err), "loop error: " .. tostring(err)) end
    return false
end)

-- a hit lands: the multiplier and the overlay answer at once, on the game's own thread (only while one of them is on)
local lastHitTick = -1
local hooked, hookErr = pcall(function()
    RegisterHook("/Script/Archon.ArchonCombatTextComponent:MulticastSendMultitypeCombatText", function()
        if T.damage <= 1 and not T.track and not (T.lock and LK.want) then return end
        local now = os.clock()
        if now - lastHitTick < 0.03 then return end
        lastHitTick = now
        pcall(tick)
        pcall(trackTick, now)   -- the overlay moves with the hit, not on the next timer tick
        if T.track then pcall(stagFromFunctions) end
        if T.lock and LK.want and not LK.src then onFrame("hit") end   -- no frame event found yet: at least on hits
    end)
end)
log(hooked and "hit hook ready" or ("hit hook not available (" .. tostring(hookErr) .. "); the timer still runs"))

-- lock-on keys (your game only, and only with lock-on turned on in the panel): middle mouse or F7 lock / let go, F8 next part
pcall(function()
    local mid = Key.MID_MOUSE_BUTTON or Key.MIDDLE_MOUSE_BUTTON
    if mid then RegisterKeyBind(mid, function() pcall(lockToggle) end) end
    RegisterKeyBind(Key.F7, function() pcall(lockToggle) end)
    RegisterKeyBind(Key.F8, function() pcall(lockNextPart) end)
end)

log("loaded (v5: damage multiplier, overlay tracking with stagger, part lock-on, instant refresh)")
