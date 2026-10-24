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
local function log(m) print("[DFTrainer] " .. tostring(m) .. "\n") end
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
if Base then log("mod folder: " .. Base .. " (process " .. ProcId .. ")") else log("could not find the mod folder; the panel cannot reach this process") end

---------------------------------------------------------------- toggles (flat JSON written by the panel)
local T = { damage = 1, refresh = false, refreshFn = "", locked = false, track = false }
local togglesText = ""

local function parseToggles(s)
    local function flag(k) return s:find('"' .. k .. '"%s*:%s*true') ~= nil end
    T.damage  = math.max(1, math.min(1000, tonumber(s:match('"damage"%s*:%s*(%-?[%d%.]+)')) or 1))
    T.refresh = flag("refresh")
    T.refreshFn = s:match('"refreshFn"%s*:%s*"([%w_]*)"') or ""
    T.locked = flag("locked")   -- not the owner's panel: no multiplier, no refresh
    if T.locked then T.damage, T.refresh = 1, false end
    T.track = flag("track")     -- the behemoth overlay is on (anyone's panel)
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
        log(string.format("toggles: damage=x%g refresh=%s track=%s", T.damage, tostring(T.refresh), tostring(T.track)))
    end
end

---------------------------------------------------------------- what is in this process
local S = { role = "server", behemoths = {}, owners = {} }
local lastRescan = -100

local function isLocal(pc)
    local ok, res = pcall(function() return pc:IsLocalController() end)
    return ok and res == true
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
    S.role = isGame and "game" or "server"
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
    return function() return readNum(st, "CurrentHealth"), readNum(st, "MaxHealth") end
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
local function findParts(e, sets)
    local parts, seen = {}, {}
    for _, comp in ipairs(findAll({ "MonsterPartComponent" })) do
        if under(pathOf(comp), e.path) then
            local actor = linkedActor(comp)
            if actor then
                local read = partReader(actor, sets)
                local name = prettyPart(lastName(comp))
                local id = nameOf(actor) or name
                if read and not seen[id] then
                    seen[id] = true
                    parts[#parts + 1] = { name = name, read = read }
                end
            end
        end
    end
    table.sort(parts, function(a, b) return a.name < b.name end)
    local count, nth = {}, {}
    for _, p in ipairs(parts) do count[p.name] = (count[p.name] or 0) + 1 end
    for _, p in ipairs(parts) do     -- two "Leg" parts: "Leg 1", "Leg 2"
        if count[p.name] > 1 then local base = p.name nth[base] = (nth[base] or 0) + 1 p.name = base .. " " .. nth[base] end
    end
    return parts
end

local function trackScan(now)
    Tk.lastScan = now
    local found = {}
    local bl = findAll({ "ArchonBehemoth" })
    local sets = nil
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
                          parts = {}, partsAt = -100, partLast = {} }
                    Tk.list[key] = e
                end
            end
            if e then
                found[key] = true
                if S.role == "server" and #e.parts == 0 and now - e.partsAt >= TRACK_PARTS then   -- parts exist on hunt servers only
                    e.partsAt = now
                    sets = sets or findAll({ "ArchonHealthAttributeSet" })
                    local ok, ps = pcall(findParts, e, sets)
                    if ok then
                        e.parts = ps
                        if #ps > 0 then log(string.format("overlay: %s has %d part(s) (%s)", e.cls, #ps, S.role)) end
                    else logOnce("parts:" .. tostring(ps), "overlay: part search failed: " .. tostring(ps)) end
                end
            end
        end
    end
    for key in pairs(Tk.list) do if not found[key] then Tk.list[key] = nil end end
end

local function trackJson(e)
    local hp, mx = readNum(e.set, "CurrentHealth") or 0, readNum(e.set, "MaxHealth") or 0
    local ps = {}
    for _, p in ipairs(e.parts) do
        local c, m = p.read()
        if c and m and m > 0 then ps[#ps + 1] = string.format('["%s",%.0f,%.0f]', clean(p.name), math.max(c, 0), m) end
    end
    return string.format('{"key":"%s","cls":"%s","cur":%.0f,"max":%.0f,"at":%d,"n":%d,"dead":%s,"parts":[%s]}',
        clean(e.key), clean(e.cls), math.max(hp, 0), mx, e.atTime or 0, e.n or 0, tostring(hp <= 0), table.concat(ps, ","))
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
            for i, p in ipairs(e.parts) do
                local c = p.read()
                if c and e.partLast[i] and c < e.partLast[i] - 0.01 then hit = true end
                e.partLast[i] = c
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

---------------------------------------------------------------- status heartbeat for the panel
local lastStatus, lastRead = -100, -100
local function writeStatus(now)
    lastStatus = now
    if not StatusFile then return end
    local f = io.open(StatusFile, "w")
    if not f then logOnce("nostatus", "cannot write " .. StatusFile .. " (the panel creates the status folder when it installs the mod)") return end
    local fns = invFns and table.concat({ table.unpack(invFns, 1, math.min(#invFns, 6)) }, ",") or ""
    f:write(string.format('{"role":"%s","time":%d,"behemoths":%d,"damage":%g,"invFns":"%s","called":"%s","calledAt":%d}',
        S.role, os.time(), #S.behemoths, T.damage, clean(fns), clean(S.called or ""), S.calledAt or 0))
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
    if now - lastStatus >= STATUS_EVERY then
        if T.damage <= 1 and not T.refresh and now - lastRescan >= 10 then pcall(rescan, now) end   -- role only
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
        if T.damage <= 1 and not T.track then return end
        local now = os.clock()
        if now - lastHitTick < 0.03 then return end
        lastHitTick = now
        pcall(tick)
        pcall(trackTick, now)   -- the overlay moves with the hit, not on the next timer tick
    end)
end)
log(hooked and "hit hook ready" or ("hit hook not available (" .. tostring(hookErr) .. "); the timer still runs"))

log("loaded (v4: damage multiplier, overlay tracking, instant refresh)")
