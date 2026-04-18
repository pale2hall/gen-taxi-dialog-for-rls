-- RLS Taxi Voice — Companion extension for RLS Career Overhaul
-- Provides: config bridge, game context (map/time/vehicle), reactive event
-- detection (police chase, vehicle damage, speed cameras), and full file logging.

local M = {}

-- ============================================================
-- FILE LOGGING
-- All log output goes to:
--   settings/taxiVoiceLog/session.json    (rolling event log)
--   settings/taxiVoiceLog/responses.json  (AI scripts + timestamps)
-- These are written on every entry so crashes don't lose data.
-- ============================================================
local LOG_DIR       = "settings/taxiVoiceLog"
local SESSION_LOG   = LOG_DIR .. "/session.json"
local RESPONSE_LOG  = LOG_DIR .. "/responses.json"

local sessionEntries  = {}
local responseEntries = {}
local MAX_LOG_ENTRIES = 500  -- rotate after this many lines

local function ts()
    return os.date('%Y-%m-%d %H:%M:%S')
end

local function fileLog(level, msg)
    -- Always print to BeamNG's built-in console (visible in F8)
    log(level, 'taxiVoice', msg)
    -- Append to in-memory buffer and flush to disk
    table.insert(sessionEntries, { t = ts(), lvl = level, msg = msg })
    if #sessionEntries > MAX_LOG_ENTRIES then
        table.remove(sessionEntries, 1)
    end
    pcall(function() jsonWriteFile(SESSION_LOG, sessionEntries, true) end)
end

local function logI(msg) fileLog('I', msg) end
local function logW(msg) fileLog('W', msg) end
local function logE(msg) fileLog('E', msg) end

-- Called from JS: gameplay_taxiVoice.logFromJS("message")
-- Lets the JS layer write to the same log file without a separate mechanism.
local function logFromJS(message)
    fileLog('I', '[JS] ' .. tostring(message))
end

-- Called from JS after every successful LLM + TTS cycle.
-- Persists the generated script and metadata to responses.json.
local function saveAIResponse(eventType, passengerType, voiceName, script)
    local entry = {
        t            = ts(),
        event        = tostring(eventType or ''),
        passengerType = tostring(passengerType or ''),
        voice        = tostring(voiceName or ''),
        script       = tostring(script or ''),
    }
    table.insert(responseEntries, entry)
    if #responseEntries > MAX_LOG_ENTRIES then
        table.remove(responseEntries, 1)
    end
    pcall(function() jsonWriteFile(RESPONSE_LOG, responseEntries, true) end)
    logI(string.format('AI response saved [%s/%s]: "%s"', eventType, passengerType, script))
end

-- ============================================================
-- CONFIG
-- ============================================================
local CONFIG_PATH = "settings/taxiVoice.json"
local config = nil

local function loadConfig()
    local raw = jsonReadFile(CONFIG_PATH)
    if raw then
        config = raw
        logI('Config loaded from ' .. CONFIG_PATH ..
             ' | enabled=' .. tostring(raw.enabled) ..
             ' | llm.host=' .. tostring(raw.llm and (raw.llm.host or raw.llm.baseUrl) or 'nil'))
    else
        config = { enabled = false }
        logW('Config NOT FOUND at ' .. CONFIG_PATH ..
             ' — copy settings/taxiVoice.json from the mod folder to Documents/BeamNG.drive/settings/ and fill in your API keys')
    end
end

-- Called from JS: bngApi.engineLua('gameplay_taxiVoice.requestConfig()')
local function requestConfig()
    if not config then loadConfig() end
    guihooks.trigger('taxiVoiceConfig', config)
    logI('Config sent to JS (enabled=' .. tostring(config and config.enabled) .. ')')
end

local function reloadConfig()
    loadConfig()
    guihooks.trigger('taxiVoiceConfig', config)
end

-- ============================================================
-- GAME CONTEXT  (map name, time of day, vehicle)
-- ============================================================
local MAP_DISPLAY_NAMES = {
    ['west_coast_usa']        = 'West Coast USA',
    ['italy']                 = 'Italy',
    ['gridmap_v2']            = 'Grid Map',
    ['small_island']          = 'Small Island',
    ['johnson_valley']        = 'Johnson Valley',
    ['derby']                 = 'Derby',
    ['automation_test_track'] = 'Automation Test Track',
    ['east_coast_usa']        = 'East Coast USA',
    ['driver_training']       = 'Driver Training',
    ['hirochi_raceway']       = 'Hirochi Raceway',
    ['industrial']            = 'Industrial Site',
    ['jungle_rock_island']    = 'Jungle Rock Island',
    ['utah']                  = 'Utah',
    ['small_town']            = 'Small Town',
}

local VEHICLE_DISPLAY_NAMES = {
    ['sunburst']  = 'Hirochi Sunburst',
    ['covet']     = 'Ibishu Covet',
    ['200bx']     = 'Ibishu 200BX',
    ['vivace']    = 'Ibishu Vivace',
    ['pessima']   = 'Ibishu Pessima',
    ['pigeon']    = 'Ibishu Pigeon',
    ['legran']    = 'Ibishu LeGran',
    ['wendover']  = 'ETK Wendover',
    ['800']       = 'ETK 800 Series',
    ['i_series']  = 'ETK i-Series',
    ['k_series']  = 'ETK K-Series',
    ['bolide']    = 'Civetta Bolide',
    ['scintilla'] = 'Civetta Scintilla',
    ['van']       = 'Gavril Van',
    ['pickup']    = 'Gavril Pickup',
    ['d_series']  = 'Gavril D-Series',
    ['t_series']  = 'Gavril T-Series',
    ['roamer']    = 'Gavril Roamer',
    ['burnside']  = 'Gavril Burnside',
    ['barstow']   = 'Gavril Barstow',
    ['grand_marshal'] = 'Gavril Grand Marshal',
    ['moonhawk']  = 'Gavril Moonhawk',
    ['miramar']   = 'Bruckell Miramar',
    ['bastion']   = 'Bruckell Bastion',
    ['lansdale']  = 'Bruckell Lansdale',
    ['autobello'] = 'Autobello Piccolina',
    ['hopper']    = 'Ibishu Hopper',
    ['sbr']       = 'SBR 4',
}

local function getTimeDescription(tod)
    local hour   = math.floor(tod * 24)
    local minute = math.floor((tod * 24 - hour) * 60)
    local period = hour < 12 and 'AM' or 'PM'
    local dh     = hour % 12; if dh == 0 then dh = 12 end
    local timeStr = string.format('%d:%02d %s', dh, minute, period)
    local label
    if     hour >= 5  and hour < 7  then label = 'Early morning'
    elseif hour >= 7  and hour < 12 then label = 'Morning'
    elseif hour >= 12 and hour < 14 then label = 'Midday'
    elseif hour >= 14 and hour < 17 then label = 'Afternoon'
    elseif hour >= 17 and hour < 20 then label = 'Evening'
    elseif hour >= 20 and hour < 23 then label = 'Night'
    else                                  label = 'Late night' end
    return label, timeStr
end

local function requestContext()
    local vehModel, vehDisplayName, vehBrand = '', '', ''
    local playerVehId = be:getPlayerVehicleID(0)
    if playerVehId and playerVehId ~= -1 then
        local veh = be:getObjectByID(playerVehId)
        if veh then
            local jbeam = veh:getField('jbeam', 0) or ''
            vehModel = jbeam
            vehDisplayName = VEHICLE_DISPLAY_NAMES[jbeam] or jbeam
            if vehDisplayName ~= '' then
                vehBrand = vehDisplayName:match('^(%S+)') or ''
            end
        end
    end

    local tod = 0.5
    if core_environment and core_environment.getTimeOfDay then
        tod = core_environment.getTimeOfDay()
    end
    local timeLabel, timeStr = getTimeDescription(tod)

    local mapId, mapDisplayName = '', ''
    if core_levels then
        local fn = (core_levels.getFileName and core_levels.getFileName()) or ''
        mapId = fn:match('([^/\\]+)$') or fn
        mapId = mapId:match('(.+)%..+$') or mapId
        mapDisplayName = MAP_DISPLAY_NAMES[mapId] or mapId:gsub('_', ' ')
    end

    local ctx = {
        vehicleModel       = vehModel,
        vehicleDisplayName = vehDisplayName,
        vehicleBrand       = vehBrand,
        gameTime           = tod,
        timeLabel          = timeLabel,
        timeStr            = timeStr,
        mapId              = mapId,
        mapDisplayName     = mapDisplayName,
    }

    guihooks.trigger('taxiVoiceContext', ctx)
    logI(string.format('Context sent to JS: vehicle=%s map=%s time=%s',
        vehDisplayName, mapDisplayName, timeStr))
end

-- ============================================================
-- REACTIVE EVENT TRACKING
-- ============================================================
local inRide          = false
local policeAlertFired = false
local lastDamage      = 0

local function setInRide(active)
    inRide = active
    if not active then
        policeAlertFired = false
        lastDamage = 0
    end
    logI('setInRide(' .. tostring(active) .. ')')
end

local function onSpeedTrapTriggered(speedTrapData, playerSpeed, overSpeed)
    if not inRide then return end
    if not config or not config.enabled then return end

    local playerVehId = be:getPlayerVehicleID(0)
    if speedTrapData and speedTrapData.subjectID ~= playerVehId then return end

    local speedKmh = playerSpeed and math.floor(playerSpeed * 3.6) or 0
    local limitKmh = speedTrapData and speedTrapData.speedLimit
        and math.floor(speedTrapData.speedLimit * 3.6) or 0

    guihooks.trigger('taxiVoiceEvent', {
        event          = 'speedCamera',
        playerSpeed    = playerSpeed or 0,
        playerSpeedKmh = speedKmh,
        speedLimit     = speedTrapData and speedTrapData.speedLimit or 0,
        speedLimitKmh  = limitKmh,
        overSpeed      = overSpeed or 0,
        trapType       = speedTrapData and speedTrapData.speedTrapType or 'speed',
    })
    logI(string.format('Speed camera fired: %d km/h in %d km/h zone', speedKmh, limitKmh))
end

local POLL_INTERVAL = 0.8
local pollTimer = 0

local function checkPoliceChase()
    local police = extensions.gameplay_police
    if not police then return end
    local wantedLevel = 0
    if police.getVars then
        local vars = police.getVars()
        wantedLevel = (vars and vars.wantedLevel) or 0
    end
    if wantedLevel > 0 and not policeAlertFired then
        policeAlertFired = true
        guihooks.trigger('taxiVoiceEvent', { event = 'policeChase', wantedLevel = wantedLevel })
        logI('Police chase fired, wanted level: ' .. tostring(wantedLevel))
    end
    if wantedLevel == 0 then policeAlertFired = false end
end

local function checkVehicleDamage()
    if not config then return end
    local threshold = config.crashDamageThreshold or 0.08
    local playerVehId = be:getPlayerVehicleID(0)
    if not playerVehId or playerVehId == -1 then return end
    local veh = be:getObjectByID(playerVehId)
    if not veh then return end
    local damage = tonumber(veh:getField('damage', 0)) or 0
    local delta = damage - lastDamage
    if delta >= threshold then
        local severity = delta < 0.2 and 'minor' or (delta < 0.5 and 'moderate' or 'severe')
        guihooks.trigger('taxiVoiceEvent', { event = 'crash', severity = severity, delta = delta })
        logI(string.format('Crash fired: delta=%.3f severity=%s', delta, severity))
    end
    lastDamage = damage
end

-- ============================================================
-- EXTENSION LIFECYCLE
-- ============================================================
local function onExtensionLoaded()
    -- Unconditional startup log — always visible in F8 console
    log('I', 'taxiVoice', '=== RLS Taxi Voice extension loading ===')
    loadConfig()
    log('I', 'taxiVoice', '=== RLS Taxi Voice extension ready (enabled=' ..
        tostring(config and config.enabled) .. ') ===')
    logI('Log file: ' .. SESSION_LOG)
    logI('Response log: ' .. RESPONSE_LOG)
end

local function onUpdate(dt)
    if not inRide then return end
    if not config or not config.enabled then return end
    pollTimer = pollTimer + dt
    if pollTimer < POLL_INTERVAL then return end
    pollTimer = 0
    checkPoliceChase()
    checkVehicleDamage()
end

-- ============================================================
-- EXPORTS
-- ============================================================
M.onExtensionLoaded    = onExtensionLoaded
M.onUpdate             = onUpdate
M.requestConfig        = requestConfig
M.reloadConfig         = reloadConfig
M.requestContext       = requestContext
M.setInRide            = setInRide
M.onSpeedTrapTriggered = onSpeedTrapTriggered
M.logFromJS            = logFromJS       -- JS → Lua → file
M.saveAIResponse       = saveAIResponse  -- JS → Lua → responses.json

return M
