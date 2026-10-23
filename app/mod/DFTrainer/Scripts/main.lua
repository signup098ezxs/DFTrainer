-- SPDX-License-Identifier: AGPL-3.0-only
-- Lantern Client: in-game cheats for Dauntless 1.6.2 (Dauntless Forever / UE4SS 3.0.1).
--
-- The trainer panel writes trainer-toggles.json into this mod's folder; this script reads it a few times a second.
-- The folder is shared by your game and every hidden server copy (they all run the same exe), so the same switches
-- reach the hunt servers, which own health and damage. Turn on "Also run mods on my servers" or god mode and the
-- damage multiplier only show on screen and get put back by the server.
--
-- Only property reads and writes are used: the healthbar mod notes that calling game functions from Lua does not
-- return usable results in this setup, but properties work.
--
-- Hotkeys (in the game window): F8 god mode, F9 infinite stamina (F6/F7 belong to the bundled DamageMeter mod).
-- Everything is logged as [DFTrainer] in UE4SS.log.
--
-- How it runs: a LoopAsync timer calls the cheats directly. ExecuteInGameThread is not used: it needs UE4SS's
-- EngineTick hook, which does not work in this game (the bundled DamageMeter mod found the same), so nothing queued
-- through it ever ran. The cheats also run from the combat-text hook (every hit), which is on the game's own thread,
-- so a hit is answered at once. Cheats are for the owner: without the owner's switches ("locked") nothing changes.

local TICK_MS      = 150    -- how often values are topped up (and right after every hit, see the hook below)
local RESCAN_EVERY = 2.0    -- seconds between searches for players, behemoths and their attribute objects
local READ_EVERY   = 0.5    -- seconds between reads of the toggles file
local STATUS_EVERY = 2.0    -- seconds between status heartbeats for the panel

local PC_CLASSES       = { "player_controller_bp_C", "ArchonPlayerController", "PlayerController" }
local PLAYER_SETS      = { "ArchonHealthAttributeSet" }
local STAMINA_CLASSES  = { "ArchonStaminaComponent", "ArchonStaminaAttributeSet", "ArchonHealthAttributeSet" }
local STAMINA_CUR_TRY  = { "CurrentStamina", "Stamina", "StaminaCurrent", "CurStamina" }
local STAMINA_MAX_TRY  = { "MaxStamina", "StaminaMax", "MaximumStamina" }

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
local T = { godmode = false, stamina = false, damage = 1, speed = 1, refresh = false, refreshFn = "", locked = false }
local togglesText = ""

local function parseToggles(s)
    local function flag(k) return s:find('"' .. k .. '"%s*:%s*true') ~= nil end
    local function num(k, d)
        local v = tonumber(s:match('"' .. k .. '"%s*:%s*(%-?[%d%.]+)'))
        return v or d
    end
    T.godmode = flag("godmode")
    T.stamina = flag("stamina")
    T.damage  = math.max(1, math.min(1000, num("damage", 1)))
    T.speed   = math.max(0.5, math.min(5, num("speed", 1)))
    T.refresh = flag("refresh")
    T.refreshFn = s:match('"refreshFn"%s*:%s*"([%w_]*)"') or ""
    -- no valid key in the panel: everything stays off
    T.locked = flag("locked")
    if T.locked then T.godmode, T.stamina, T.damage, T.speed, T.refresh = false, false, 1, 1, false end
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
        log(string.format("toggles: god=%s stamina=%s damage=x%g speed=x%g", tostring(T.godmode), tostring(T.stamina), T.damage, T.speed))
    end
end

-- hotkeys write the file back, so the servers and the panel follow
local function writeToggles()
    if not TogglesFile then return end
    local f = io.open(TogglesFile, "w")
    if not f then return end
    local s = string.format('{"godmode":%s,"stamina":%s,"damage":%g,"speed":%g,"refresh":%s,"refreshFn":"%s","by":"hotkey","time":%d}',
        tostring(T.godmode), tostring(T.stamina), T.damage, T.speed, tostring(T.refresh), T.refreshFn, os.time())
    f:write(s)
    f:close()
    togglesText = s
end

---------------------------------------------------------------- what is in this process
local S = {
    role = "server", players = {}, behemoths = {},
    stamina = nil,   -- { cur = "PropName", max = "PropName"|nil, cls = "Class" }
    staminaLogged = false,
}
local lastRescan = -100
local staminaCache = {}   -- class name -> { current property, max property } or false

-- the game is the only copy with a local player (your screen and keyboard); server copies only have remote controllers
-- (the same test as the bundled DamageMeter mod)
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

-- every float property name on an object, walking up its classes
local function propNames(o)
    local names = {}
    local ok, cls = pcall(function() return o:GetClass() end)
    local depth = 0
    while ok and cls and valid(cls) and depth < 8 do
        pcall(function()
            cls:ForEachProperty(function(p)
                local okN, n = pcall(function() return p:GetFName():ToString() end)
                if okN and n then names[#names + 1] = n end
            end)
        end)
        local okS, sup = pcall(function() return cls:GetSuperStruct() end)
        if not okS then break end
        cls = sup
        depth = depth + 1
    end
    return names
end

-- which property is "current stamina" and which is its maximum, on this object (nil if none)
local function staminaPropsOf(o)
    local cur, max
    local names = propNames(o)
    local candidates = {}
    for _, n in ipairs(names) do
        local l = n:lower()
        if l:find("stamina", 1, true) and readNum(o, n) then candidates[#candidates + 1] = n end
    end
    if #candidates == 0 then   -- ForEachProperty missing or found nothing: try the usual names
        for _, n in ipairs(STAMINA_CUR_TRY) do if readNum(o, n) then candidates[#candidates + 1] = n end end
        for _, n in ipairs(STAMINA_MAX_TRY) do if readNum(o, n) then candidates[#candidates + 1] = n end end
    end
    local function bad(l) return l:find("regen", 1, true) or l:find("rate", 1, true) or l:find("cost", 1, true)
        or l:find("delay", 1, true) or l:find("upgrade", 1, true) or l:find("glider", 1, true) or l:find("percent", 1, true) end
    for _, n in ipairs(candidates) do
        local l = n:lower()
        if not bad(l) then
            if l:find("max", 1, true) then max = max or n
            elseif l == "stamina" or l:find("current", 1, true) or l:find("cur", 1, true) then cur = cur or n end
        end
    end
    if not cur then for _, n in ipairs(candidates) do local l = n:lower() if not bad(l) and not l:find("max", 1, true) then cur = n break end end end
    if cur and not S.staminaLogged then
        S.staminaLogged = true
        log("stamina properties seen: " .. table.concat(candidates, ", "))
    end
    return cur, max
end

local function rescan(now)
    lastRescan = now
    local players, isGame = {}, false
    local owners = {}
    for _, pc in ipairs(findAll(PC_CLASSES)) do
        if isLocal(pc) then isGame = true end
        local okP, pawn = pcall(function() return pc.Pawn end)
        if okP and valid(pawn) then
            local okS, ps = pcall(function() return pc.PlayerState end)
            owners[#owners + 1] = { pawn = pawn, path = pathOf(pawn), psPath = (okS and valid(ps)) and pathOf(ps) or nil, pcPath = pathOf(pc) }
        end
    end
    if not isGame and hasLocalPlayer() then isGame = true end
    S.role = isGame and "game" or "server"

    local healthSets = findAll(PLAYER_SETS)
    local staminaObjs = findAll(STAMINA_CLASSES)
    for _, ow in ipairs(owners) do
        local p = { pawn = ow.pawn, health = {}, stamina = {} }
        for _, s in ipairs(healthSets) do
            local sp = pathOf(s)
            if (under(sp, ow.path) or under(sp, ow.psPath)) and readNum(s, "MaxHealth") then p.health[#p.health + 1] = s end
        end
        for _, o in ipairs(staminaObjs) do
            local op = pathOf(o)
            if under(op, ow.path) or under(op, ow.psPath) then
                -- which properties hold stamina is the same for every object of a class: found once, then reused
                local cls = (nameOf(o) or ""):match("^(%S+)") or ""
                local cached = staminaCache[cls]
                if cached == nil then
                    local c, m = staminaPropsOf(o)
                    cached = c and { c, m } or false
                    staminaCache[cls] = cached
                end
                local cur, max = nil, nil
                if cached then cur, max = cached[1], cached[2] end
                if cur then
                    p.stamina[#p.stamina + 1] = { obj = o, cur = cur, max = max, top = readNum(o, cur) or 0 }
                    S.stamina = { cur = cur, max = max, cls = (nameOf(o) or ""):match("^(%S+)") }
                end
            end
        end
        local okM, mv = pcall(function() return ow.pawn.CharacterMovement end)
        p.move = (okM and valid(mv)) and mv or nil
        players[#players + 1] = p
    end
    -- keep what we learned about walk speed per pawn across rescans
    for _, np in ipairs(players) do
        for _, op in ipairs(S.players) do
            if op.pawn == np.pawn or nameOf(op.pawn) == nameOf(np.pawn) then np.baseSpeed, np.wroteSpeed = op.baseSpeed, op.wroteSpeed end
        end
    end
    S.players = players
    S.owners = owners

    local behemoths = {}
    local okB, blist = pcall(FindAllOf, "ArchonBehemoth")
    for _, b in ipairs(okB and blist or {}) do
        if valid(b) then
            local bp = pathOf(b)
            local best, bestMax = nil, 0
            for _, s in ipairs(healthSets) do
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
    S.behemoths = behemoths
    local hs, ss, mv = 0, 0, 0
    for _, p in ipairs(players) do hs = hs + #p.health ss = ss + #p.stamina if p.move then mv = mv + 1 end end
    local summary = string.format("%s: %d player(s), health sets %d, stamina %d%s, movement %d, behemoths %d", S.role, #players, hs, ss,
        S.stamina and (" (" .. S.stamina.cls .. "." .. S.stamina.cur .. ")") or "", mv, #behemoths)
    if summary ~= S.lastSummary then S.lastSummary = summary log(summary) end
end

---------------------------------------------------------------- the cheats
local function tick()
    local now = os.clock()
    if now - lastRescan >= RESCAN_EVERY then rescan(now) end

    for _, p in ipairs(S.players) do
        if T.godmode then
            for _, s in ipairs(p.health) do
                if valid(s) then
                    local hp, mx = readNum(s, "CurrentHealth"), readNum(s, "MaxHealth")
                    if hp and mx and mx > 0 and hp < mx and writeNum(s, "CurrentHealth", mx) then
                        logOnce("god", string.format("god mode working: health %.0f -> %.0f (%s)", hp, mx, S.role))
                    end
                end
            end
        end
        if T.stamina then
            for _, st in ipairs(p.stamina) do
                if valid(st.obj) then
                    local v = readNum(st.obj, st.cur)
                    local top = st.max and readNum(st.obj, st.max) or nil
                    if v and v > st.top then st.top = v end   -- no max property: the highest value seen is full
                    top = (top and top > 0) and top or st.top
                    if v and top and top > 0 and v < top and writeNum(st.obj, st.cur, top) then
                        logOnce("stam", string.format("infinite stamina working: %s %.0f -> %.0f (%s)", st.cur, v, top, S.role))
                    end
                end
            end
        end
        if p.move and valid(p.move) then
            local cur = readNum(p.move, "MaxWalkSpeed")
            if cur then
                -- the game changes MaxWalkSpeed itself (sprint, weapons): anything we did not write is the new base
                if p.wroteSpeed == nil or math.abs(cur - p.wroteSpeed) > 0.01 then p.baseSpeed = cur end
                if T.speed ~= 1 and p.baseSpeed then
                    local want = p.baseSpeed * T.speed
                    if math.abs(cur - want) > 0.01 and writeNum(p.move, "MaxWalkSpeed", want) then
                        p.wroteSpeed = want
                        logOnce("speed", string.format("move speed working: %.0f -> %.0f (%s)", p.baseSpeed, want, S.role))
                    end
                elseif p.wroteSpeed and p.baseSpeed then
                    writeNum(p.move, "MaxWalkSpeed", p.baseSpeed)   -- switched back to x1
                    p.wroteSpeed = nil
                end
            end
        end
    end

    -- damage multiplier: every health drop on a behemoth is repeated (mult - 1) more times, never below 1 HP,
    -- so the game's own hit still lands the kill
    for _, b in ipairs(S.behemoths) do
        if valid(b.set) then
            local hp = readNum(b.set, "CurrentHealth")
            if hp then
                if T.damage > 1 and b.last and hp < b.last then
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

---------------------------------------------------------------- status heartbeat for the panel
local lastStatus, lastRead = -100, -100
local function clean(s) return (tostring(s or ""):gsub('[^%w_ .,:/>-]', '')) end
local function writeStatus(now)
    lastStatus = now
    if not StatusFile then return end
    local f = io.open(StatusFile, "w")
    if not f then logOnce("nostatus", "cannot write " .. StatusFile .. " (the panel creates the status folder when it installs the mod)") return end
    local hsets, ssets = 0, 0
    for _, p in ipairs(S.players) do hsets = hsets + #p.health ssets = ssets + #p.stamina end
    local st = S.stamina and (S.stamina.cls .. " " .. S.stamina.cur .. (S.stamina.max and (" / " .. S.stamina.max) or "")) or ""
    local fns = invFns and table.concat({ table.unpack(invFns, 1, math.min(#invFns, 6)) }, ",") or ""
    f:write(string.format('{"role":"%s","time":%d,"players":%d,"healthSets":%d,"staminaSets":%d,"stamina":"%s","behemoths":%d,"godmode":%s,"staminaOn":%s,"damage":%g,"speed":%g,"invFns":"%s","called":"%s","calledAt":%d}',
        S.role, os.time(), #S.players, hsets, ssets, clean(st), #S.behemoths, tostring(T.godmode), tostring(T.stamina), T.damage, T.speed,
        clean(fns), clean(S.called or ""), S.calledAt or 0))
    f:close()
end

---------------------------------------------------------------- loop
local function step()
    local now = os.clock()
    if now - lastRead >= READ_EVERY then lastRead = now readToggles() pcall(checkRefresh) end
    local ok, err = pcall(tick)
    if not ok then logOnce("tick:" .. tostring(err), "tick error: " .. tostring(err)) end
    if now - lastStatus >= STATUS_EVERY then pcall(writeStatus, now) end
end

LoopAsync(TICK_MS, function()
    local ok, err = pcall(step)
    if not ok then logOnce("step:" .. tostring(err), "loop error: " .. tostring(err)) end
    return false
end)

-- every hit (yours or a behemoth's) runs the cheats at once, on the game's own thread
local lastHitTick = -1
local hooked, hookErr = pcall(function()
    RegisterHook("/Script/Archon.ArchonCombatTextComponent:MulticastSendMultitypeCombatText", function()
        local now = os.clock()
        if now - lastHitTick < 0.03 then return end
        lastHitTick = now
        pcall(tick)
    end)
end)
log(hooked and "hit hook ready" or ("hit hook not available (" .. tostring(hookErr) .. "); the timer still runs the cheats"))

pcall(function()
    RegisterKeyBind(Key.F8, function()
        if S.role ~= "game" or T.locked then return end
        T.godmode = not T.godmode
        writeToggles()
        log("F8: god mode " .. (T.godmode and "on" or "off"))
    end)
    RegisterKeyBind(Key.F9, function()
        if S.role ~= "game" or T.locked then return end
        T.stamina = not T.stamina
        writeToggles()
        log("F9: infinite stamina " .. (T.stamina and "on" or "off"))
    end)
end)

log("loaded (v2: timer + hit hook, F8/F9)")
