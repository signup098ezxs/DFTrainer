-- SPDX-License-Identifier: AGPL-3.0-only
-- Lantern Client: Model Swaps for Dauntless 1.14.7 (Dauntless Forever / UE4SS 3.0.1).
--
-- Shows another character model in place of YOUR Slayer, on your screen only. Lantern's panel puts the character's
-- pak in the game (new files under /Game/Lantern/ModelSwaps/, nothing of the game is replaced) and writes
-- modelswap.json into this folder. The work on the Slayer is done by Lantern's native library (lantern_native.dll:
-- it sets the mesh on your Slayer's body and hides head, hair, armour and accessories; armour stays equipped), because
-- UE4SS 3.0.1 cannot pass arguments to this game's functions. This script only:
--   - loads that library, and
--   - tells it three things it cannot find by itself: the engine's "load an asset" function, the object that
--     function belongs to, and the name of the character's mesh.
-- Looks only: no stat, hitbox, collision, movement or animation is changed, nothing is sent to the server, and other
-- players, NPCs and behemoths are never touched.
--
-- Rules kept from Lantern's tracker mod: game objects are only touched inside hooks (the game's own thread), never
-- from the timer; no game object is kept between passes.

local MOD_VERSION = "1.1"

---------------------------------------------------------------- helpers
local LogFile = nil
local function log(m)
    print("[ModelSwaps] " .. tostring(m) .. "\n")
    if LogFile then
        local f = io.open(LogFile, "a")
        if f then f:write(os.date("%H:%M:%S ") .. tostring(m) .. "\n") f:close() end
    end
end
local function fileExists(p)
    local f = io.open(p, "r")
    if f then f:close() return true end
    return false
end
local function modFolder()
    local ok, info = pcall(function() return debug.getinfo(1, "S") end)
    if ok and info and info.source then
        local p = info.source:gsub("^@", "")
        local dir = p:match("^(.*)[/\\][Ss][Cc][Rr][Ii][Pp][Tt][Ss][/\\][^/\\]*$")
        if dir and dir:match("^%a:[/\\]") and fileExists(dir .. "/df-mod.json") then return dir end
    end
    for entry in tostring(package.path):gmatch("[^;]+") do
        local dir = entry:match("^(.*)[/\\][Ss][Cc][Rr][Ii][Pp][Tt][Ss][/\\]%?%.lua$")
        if dir and fileExists(dir .. "/modelswaps.marker") then return dir end
    end
    return nil
end

local Base = modFolder()
local ProcId = (tostring({}):match("0x(%x+)") or tostring(os.time())):sub(-8)
if Base then LogFile = Base .. "/logs/" .. os.date("%Y%m%d-%H%M%S") .. "-" .. ProcId .. ".log" end
local ConfigFile = Base and (Base .. "/modelswap.json")

---------------------------------------------------------------- settings (flat JSON written by the panel)
local C = { on = false, mesh = "", text = nil }
local function readConfig()
    local f = ConfigFile and io.open(ConfigFile, "r")
    local s = f and f:read("a") or ""
    if f then f:close() end
    if s == C.text then return end
    C.text = s
    -- only paths under Lantern's own folder are ever named to the game
    local mesh = s:match('"mesh"%s*:%s*"(/Game/Lantern/ModelSwaps/[%w_/]+)"') or ""
    C.on = s:find('"on"%s*:%s*true') ~= nil and mesh ~= ""
    C.mesh = mesh
    log("settings: " .. (C.on and ("show " .. C.mesh) or "off (your own Slayer)"))
end

---------------------------------------------------------------- the native library
-- A loaded library's functions are all this script can call in it, and they take nothing: a number goes over one
-- hex digit at a time (ms_h0..ms_hf), then ms_fn / ms_cdo / ms_name says what the number was.
local Lib = nil
local function loadLib()
    if not Base then return end
    for _, p in ipairs({ Base .. "/native/lantern_native.dll", Base .. "/../DFTrainer/native/lantern_native.dll" }) do
        if fileExists(p) then
            local lib = { digit = {} }
            local ok = true
            for i = 0, 15 do
                local okL, fn = pcall(package.loadlib, p, string.format("ms_h%x", i))
                if okL and type(fn) == "function" then lib.digit[string.format("%x", i)] = fn else ok = false end
            end
            for _, n in ipairs({ "fn", "cdo", "name" }) do
                local okL, fn = pcall(package.loadlib, p, "ms_" .. n)
                if okL and type(fn) == "function" then lib[n] = fn else ok = false end
            end
            local okT, fnT = pcall(package.loadlib, p, "ms_tick")   -- newer libraries: the character on its own, sized part
            if okT and type(fnT) == "function" then lib.tick = fnT end
            if ok then Lib = lib; log("native library loaded: " .. p); return end
            log("this native library has no Model Swaps part (an older Lantern?): " .. p)
        end
    end
    if not Lib then log("native library not found: Model Swaps cannot show anything") end
end
local function send(what, n)
    for d in string.format("%x", n):gmatch(".") do Lib.digit[d]() end
    Lib[what]()
end

---------------------------------------------------------------- hooks (the game's own thread)
local Sent = { fn = false, mesh = nil }
local function link()   -- game thread only
    if not Lib then return end
    if not Sent.fn then
        local okF, fn = pcall(StaticFindObject, "/Script/Engine.KismetSystemLibrary:LoadAsset_Blocking")
        local okC, cdo = pcall(StaticFindObject, "/Script/Engine.Default__KismetSystemLibrary")
        if okF and okC and type(fn) == "userdata" and type(cdo) == "userdata" and fn:IsValid() and cdo:IsValid() then
            send("fn", fn:GetAddress()); send("cdo", cdo:GetAddress()); Sent.fn = true
            log("the game's asset loader was handed to the native library")
            -- where a mesh component keeps "animate while not drawn": the Slayer's body is hidden but must keep moving
            local okO, off = pcall(function()
                return StaticFindObject("/Script/Engine.Default__SkeletalMeshComponent"):Reflection():GetProperty("VisibilityBasedAnimTickOption"):GetOffset_Internal()
            end)
            if Lib.tick and okO and type(off) == "number" and off > 0 then
                send("tick", off); log("mesh components keep their animation switch at +" .. off .. ": the character gets its own, sized part")
            else
                log("the animation switch was not found (" .. tostring(off) .. "): the character is shown at the Slayer's size")
            end
        else
            Sent.fn = "failed"; log("the game's asset loader was not found: Model Swaps cannot show anything")
        end
    end
    if Sent.fn == true and C.on and Sent.mesh ~= C.mesh then
        local name = C.mesh .. "." .. C.mesh:match("([^/]+)$")
        local okN, idx = pcall(function() return FName(name):GetComparisonIndex() end)
        Sent.mesh = C.mesh
        if okN and type(idx) == "number" and idx > 0 then
            send("name", idx); log("character named to the native library: " .. name .. " (" .. idx .. ")")
        else
            log("could not name the character to the game: " .. tostring(idx))
        end
    end
end
local function onGame()
    local ok, err = pcall(link)
    if not ok then log("error: " .. tostring(err)) end
end
-- a game-thread moment that comes round all the time while you play, so a character chosen in Lantern while the game
-- runs is named at once. It can only be watched once the game has loaded the player's Blueprint: at the first spawn.
local Tick = nil
local function watchTick()
    if Tick then return end
    local fn = "/Game/Blueprints/BP_PlayerCharacter.BP_PlayerCharacter_C:ReceiveTick"
    if pcall(RegisterHook, fn, function() if C.on and Sent.mesh ~= C.mesh and Sent.fn ~= "failed" then onGame() end end) then
        Tick = fn; log("watching " .. fn)
    else
        Tick = "none"; log("no repeating game event: a character chosen while the game runs shows after the next loading screen")
    end
end
local okR = pcall(RegisterHook, "/Script/Engine.PlayerController:ClientRestart", function()
    pcall(watchTick)
    onGame()
end)
log((okR and "watching " or "not available: ") .. "/Script/Engine.PlayerController:ClientRestart")

---------------------------------------------------------------- start; timer: files only
log("Model Swaps " .. MOD_VERSION .. (Base and (" in " .. Base) or " (mod folder not found: off)"))
if Base then
    readConfig()
    loadLib()
    LoopAsync(500, function() pcall(readConfig) return false end)
end
