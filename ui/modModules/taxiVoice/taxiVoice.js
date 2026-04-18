'use strict'

// Unconditional startup marker — visible in F8 console even if config never loads
console.log('[TaxiVoice] ===== taxiVoice.js loaded at', new Date().toISOString(), '=====')

// ============================================================
// RLS TAXI VOICE
// Companion mod for RLS Career Overhaul.
//
// Listens to updateTaxiState (and taxiVoiceEvent from Lua) to detect
// ride milestones, then calls an OpenAI-compatible LLM to generate
// in-character passenger dialogue, synthesises it with ElevenLabs TTS,
// and plays it back via the Web Audio API.
//
// Supports: OpenAI, LMStudio, Ollama, or any OpenAI-compatible endpoint.
// ============================================================

// ============================================================
// PASSENGER TYPE PERSONALITY DATABASE
// Rich personality notes fed directly into the system prompt so the
// LLM can generate correctly-tuned dialogue without guessing.
// ============================================================
const PASSENGER_PERSONALITIES = {
  STANDARD: {
    wants:       'a normal, safe, timely ride',
    bonuses:     'arriving on time without incidents',
    penalties:   'aggressive driving or running red lights',
    personality: 'You\'re an ordinary person running an errand. Polite, a little tired, just want to get there without fuss. Not particularly chatty but not rude either.',
  },
  BUSINESS: {
    wants:       'an efficient, assertive ride — speed matters, punctuality is critical',
    bonuses:     'fast driving, assertive lane changes, getting through traffic quickly',
    penalties:   'slow driving, being overly cautious, taking the scenic route',
    personality: 'You\'re stressed, running behind schedule, probably on a phone call or mentally rehearsing a meeting. You speak in clipped, direct sentences. You want speed and competence. You don\'t care about comfort or scenery.',
  },
  LUXURY: {
    wants:       'an extremely smooth, comfortable ride — speed is secondary to smoothness',
    bonuses:     'gentle acceleration, smooth braking, cruising at a comfortable pace',
    penalties:   'hard braking, sharp turns, potholes hit at speed, going over ~65 mph',
    personality: 'You\'re wealthy and expect premium service as a baseline. You\'re not rude but you are particular. You notice every bump, every hard brake, every sharp turn. You speak with quiet authority. You may mention other luxury transport you\'ve used.',
  },
  COMMUTER: {
    wants:       'a steady, reliable ride — nothing flashy, just get there at a sensible pace',
    bonuses:     'consistent speed, following traffic laws, no surprises',
    penalties:   'reckless overtaking, harsh acceleration, running late',
    personality: 'You\'re exhausted from a long day. You take this route all the time and you just want silence or small talk. You\'re friendly but tired. You might doze off. You appreciate a driver who knows what they\'re doing without needing to show off.',
  },
  THRILL: {
    wants:       'maximum speed, high G-forces, aggressive cornering — the more intense the better',
    bonuses:     'high sustained G-forces, fast cornering, hard acceleration, near misses',
    penalties:   'slow, boring, overly cautious driving — you\'ll be disappointed and vocal about it',
    personality: 'You live for adrenaline. This taxi ride is an opportunity for a legal(ish) thrill. You are enthusiastic, loud, encouraging. You cheer when the driver does something fast. You get visibly bored at red lights. You treat the driver like a pilot.',
  },
  EXECUTIVE: {
    wants:       'a composed, professional ride — VIP treatment, no drama',
    bonuses:     'smooth confident driving, arriving exactly on time, clean vehicle',
    penalties:   'any erratic behaviour, drawing attention, arriving late',
    personality: 'You are a high-ranking executive. You are used to private drivers and have very high standards. You are civil but not warm. You observe everything. You will give specific, polite instructions. You do not raise your voice but your disappointment is felt.',
  },
  FAMILY: {
    wants:       'a safe, smooth ride with zero scares — children are present',
    bonuses:     'gentle driving, obeying all traffic laws, smooth stops',
    penalties:   'ANY aggressive manoeuvre, sudden braking, running lights, excessive speed',
    personality: 'You\'re a parent travelling with young kids. Safety is non-negotiable. You are warm and friendly but you will not hesitate to ask the driver to slow down. You might comment on what the kids are doing. You apologise if they make noise.',
  },
  TOURIST: {
    wants:       'an enjoyable ride with time to take in the scenery — not in a hurry',
    bonuses:     'smooth driving, pointing out interesting things, a pleasant experience overall',
    penalties:   'going so fast they can\'t see anything, aggressive driving that scares them',
    personality: 'You\'re visiting this place for the first time and everything is exciting. You ask questions about the area. You take photos out the window (or pretend to). You\'re delighted by small things. You speak with enthusiasm and genuine curiosity.',
  },
  STUDENT: {
    wants:       'to get there cheaply and in one piece — nothing fancy',
    bonuses:     'reasonable speed, not running up the fare with detours',
    penalties:   'going out of the way, scaring them with aggressive driving',
    personality: 'You\'re a broke college student. You\'re friendly, a bit awkward, probably running late to something unimportant. You might be looking at your phone. You\'re the kind of person who rates the driver 5 stars unless they do something genuinely terrible.',
  },
  PARTY: {
    wants:       'a fun, energetic ride — you\'re already in party mode',
    bonuses:     'a bit of speed, playing along with the energy, getting there fast so the night can start',
    penalties:   'being a killjoy, driving so cautiously it kills the vibe',
    personality: 'You and your crew are heading out for a big night. You\'re loud, laughing, possibly already a drink or two in. You treat the taxi driver like a fellow human being having a good time. You might offer unsolicited opinions on the music. Energy is high.',
  },
}

// Per-type driving preference summary (used in the preferences block of the prompt)
const TYPE_PREFERENCE_SUMMARY = {
  STANDARD:  'Safe, timely, unremarkable',
  BUSINESS:  'Fast, efficient, assertive — time is money',
  LUXURY:    'Silky smooth — every bump costs you a tip',
  COMMUTER:  'Steady and predictable — no drama',
  THRILL:    'FAST. G-forces. The more aggressive the better',
  EXECUTIVE: 'Composed, professional, punctual',
  FAMILY:    'Gentle and safe — children on board',
  TOURIST:   'Relaxed, scenic, enjoyable',
  STUDENT:   'Get there in one piece without detours',
  PARTY:     'Fast and fun — the night is young',
}

// Map IDs to human-readable location descriptions for richer prompts
const MAP_DESCRIPTIONS = {
  'west_coast_usa':     'West Coast USA (mix of city streets, suburbs, and open highway)',
  'italy':              'Italy (winding mountain roads, historic town centres, coastal routes)',
  'gridmap_v2':         'a flat test grid',
  'small_island':       'a small tropical island (tight roads, coastal paths)',
  'johnson_valley':     'Johnson Valley (off-road desert terrain)',
  'east_coast_usa':     'East Coast USA (dense urban grid, suburbs)',
  'hirochi_raceway':    'Hirochi Raceway (purpose-built race circuit)',
  'utah':               'Utah (red rock desert, canyon roads)',
  'small_town':         'a small American town',
}

// ============================================================
// MODULE STATE
// ============================================================
let config = null
let configLoaded = false
let rideContext = null      // map/time/vehicle — fetched once per fare
let currentFare = null      // last known fare object
let lastState = null
let lastFareFingerprint = null

// Halfway tracking
let halfwayTarget = 0
let halfwayFired = false

// Audio
let audioContext = null
const audioQueue = []
let isPlayingAudio = false

// Prevent spamming reactive events
const reactiveCooldowns = {}  // event type -> timestamp of last fire
const REACTIVE_COOLDOWN_MS = 12000  // 12s min between same reactive event type

// Conversation history — persists for the full ride so the AI remembers what it said
let conversationHistory = []   // array of {role, content} turns (user + assistant, no system)
let rideSystemPrompt = null    // built once per fare and reused across all events

// Pre-generation cache — keyed by event type, value: { script, audioBuffer }
// Populated in the background after boarding if preGenerateReactiveEvents is true.
// Allows reactive events (police/crash/speedCamera) to play with near-zero latency.
const preGenCache = {}

// ============================================================
// UTILITIES
// ============================================================

// TV_LOG: always prints, regardless of config state.
// Use for every milestone so silent failures become obvious.
function TV_LOG(...args) {
  console.log('[TaxiVoice]', ...args)
  // Also forward to Lua file log if api is available
  try {
    const api = getApi()
    if (api) {
      const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')
      api.engineLua(`if gameplay_taxiVoice then gameplay_taxiVoice.logFromJS(${JSON.stringify(msg)}) end`)
    }
  } catch (_) {}
}

// TV_DBG: only prints when debugLogging is enabled in config
function TV_DBG(...args) {
  if (config && config.debugLogging) TV_LOG(...args)
}

// Legacy alias so existing dbg() calls still work
function dbg(...args) { TV_DBG(...args) }

function getApi() {
  if (typeof bngApi !== 'undefined' && bngApi && bngApi.engineLua) return bngApi
  if (window.bngApi && window.bngApi.engineLua) return window.bngApi
  if (window.bridge && window.bridge.api && window.bridge.api.engineLua) return window.bridge.api
  return null
}

// Build the LLM base URL from config, handling every possible format:
//   host+port+path  →  http://127.0.0.1:1234/v1  (LMStudio style)
//   baseUrl string  →  normalised with http:// if missing
//   fallback        →  http://127.0.0.1:1234/v1
function buildLLMBaseUrl() {
  if (!config || !config.llm) return 'http://127.0.0.1:1234/v1'
  const llm = config.llm

  if (llm.host) {
    // Strip any protocol the user may have included in host
    let host = String(llm.host).trim().replace(/^https?:\/\//, '').replace(/\/$/, '')
    // Use https only for known cloud providers; everything else is local http
    const useHttps = (host.includes('openai.com') || host.includes('anthropic.com') || llm.https === true)
    const proto = useHttps ? 'https' : 'http'
    const port  = llm.port ? `:${llm.port}` : ''
    const path  = String(llm.path || '/v1').replace(/\/$/, '')
    const url   = `${proto}://${host}${port}${path}`
    TV_LOG(`LLM URL (host mode): ${url}  model: ${llm.model}`)
    return url
  }

  if (llm.baseUrl) {
    let url = String(llm.baseUrl).trim()
    if (!url.match(/^https?:\/\//)) url = 'http://' + url
    url = url.replace(/\/$/, '')
    TV_LOG(`LLM URL (baseUrl mode): ${url}  model: ${llm.model}`)
    return url
  }

  TV_LOG('LLM URL: falling back to LMStudio default http://127.0.0.1:1234/v1')
  return 'http://127.0.0.1:1234/v1'
}

function fareFingerprint(fare) {
  if (!fare) return null
  const px = fare.pickup && fare.pickup.pos
    ? `${(fare.pickup.pos.x || 0).toFixed(1)}${(fare.pickup.pos.z || 0).toFixed(1)}`
    : '0'
  const dx = fare.destination && fare.destination.pos
    ? `${(fare.destination.pos.x || 0).toFixed(1)}${(fare.destination.pos.z || 0).toFixed(1)}`
    : '0'
  return `${fare.passengerType || ''}${px}${dx}${fare.baseFare || 0}`
}

function isEventEnabled(eventType) {
  return config && config.enabledEvents && config.enabledEvents[eventType] !== false
}

function canFireReactive(eventType) {
  const now = Date.now()
  const last = reactiveCooldowns[eventType] || 0
  if (now - last < REACTIVE_COOLDOWN_MS) return false
  reactiveCooldowns[eventType] = now
  return true
}

function formatMoney(n) {
  return n ? `$${parseFloat(n).toFixed(2)}` : '$0.00'
}

function estimateVehicleValue(vehicleMultiplier) {
  // Inverse of: vehicleMultiplier = sqrt(vehicleValue / 30000)
  const m = vehicleMultiplier || 1
  return Math.round(m * m * 30000)
}

// ============================================================
// VOICE LIBRARY LOOKUP
// ============================================================
function getVoiceEntry(passengerType) {
  if (!config) return null
  const voiceRef = config.voices && config.voices[passengerType]
  if (!voiceRef || !voiceRef.voiceId) return null
  if (voiceRef.enabled === false) return null

  // Find metadata in voiceLibrary
  const lib = config.voiceLibrary || []
  const meta = lib.find(v => v.voiceId === voiceRef.voiceId) || {}

  return {
    voiceId: voiceRef.voiceId,
    name:    meta.name    || 'Unknown',
    gender:  meta.gender  || 'unknown',
    age:     meta.age     || 'adult',
    accent:  meta.accent  || 'american',
    style:   meta.style   || 'neutral',
  }
}

// ============================================================
// CONTEXT HELPERS
// ============================================================
function getEstimatedDistance(fare) {
  if (!fare || !fare.pickup || !fare.destination) return 0
  const pp = fare.pickup.pos
  const dp = fare.destination.pos
  if (!pp || !dp) return 0
  const dx = (dp.x || 0) - (pp.x || 0)
  const dz = (dp.z || 0) - (pp.z || 0)
  const straightLine = Math.sqrt(dx * dx + dz * dz)
  const factor = (config && config.halfwayRoadFactor) || 1.35
  return straightLine * factor  // estimated driven distance in metres
}

function formatDistance(metres) {
  if (metres >= 1000) return `${(metres / 1000).toFixed(1)} km`
  return `${Math.round(metres)} m`
}

// ============================================================
// PROMPT BUILDER
// ============================================================
function buildSystemPrompt(eventType, fare, voice) {
  const type    = fare.passengerType    || 'STANDARD'
  const typeName = fare.passengerTypeName || 'Standard'
  const desc    = fare.passengerDescription || ''
  const count   = fare.passengers || 1
  const personality = PASSENGER_PERSONALITIES[type] || PASSENGER_PERSONALITIES.STANDARD
  const prefSummary = TYPE_PREFERENCE_SUMMARY[type] || 'Get there safely'

  // Vehicle info
  const vehicleMultiplier = fare.vehicleMultiplier || (currentFare && currentFare.vehicleMultiplier) || 1
  const vehicleDisplay = (rideContext && rideContext.vehicleDisplayName) || 'a taxi'
  const vehicleBrand   = (rideContext && rideContext.vehicleBrand) || ''
  const estValue       = estimateVehicleValue(vehicleMultiplier)

  // Location & time
  const mapId      = (rideContext && rideContext.mapId) || ''
  const mapDesc    = MAP_DESCRIPTIONS[mapId] || (rideContext && rideContext.mapDisplayName) || 'the city'
  const timeLabel  = (rideContext && rideContext.timeLabel) || 'daytime'
  const timeStr    = (rideContext && rideContext.timeStr)   || ''

  // Trip details
  const baseFare     = parseFloat(fare.baseFare || 0).toFixed(2)
  const estDist      = getEstimatedDistance(fare)
  const estDistStr   = estDist > 0 ? formatDistance(estDist) : 'unknown distance'

  // Voice/persona description
  const voiceDesc = voice
    ? `${voice.age} ${voice.gender}, ${voice.accent} accent, ${voice.style} tone`
    : 'adult, neutral'

  return `You are writing short in-character spoken dialogue for a passenger in a taxi driving video game (BeamNG Drive).

══════════════════════════════════════════
PASSENGER PROFILE
══════════════════════════════════════════
Type: ${type} — ${typeName}
Description: ${desc}
Group size: ${count} passenger${count !== 1 ? 's' : ''}
Voice/persona: ${voiceDesc}

══════════════════════════════════════════
CURRENT RIDE CONTEXT
══════════════════════════════════════════
Location: ${mapDesc}
Time of day: ${timeLabel}${timeStr ? ` (${timeStr})` : ''}
Driver's vehicle: ${vehicleDisplay}${estValue > 0 ? ` (estimated value ~$${estValue.toLocaleString()})` : ''}
Metered fare: $${baseFare} | Estimated trip distance: ~${estDistStr}

══════════════════════════════════════════
PASSENGER PREFERENCES
══════════════════════════════════════════
Driving style they want: ${prefSummary}
Tip bonuses earned by: ${personality.bonuses}
Tips reduced by: ${personality.penalties}

══════════════════════════════════════════
PERSONALITY NOTES
══════════════════════════════════════════
${personality.personality}

══════════════════════════════════════════
STRICT WRITING RULES
══════════════════════════════════════════
• Maximum 2 sentences. Hard cap: 30 words total.
• Output ONLY the spoken dialogue — no stage directions, no quotation marks, no character names, no asterisks
• Stay fully in character at all times — vocabulary, energy, and concerns must match the persona above
• Reference specific details when they strengthen the line (vehicle, time of day, distance, incident)
• Use natural spoken language: contractions, "...", personality-appropriate filler words are fine
• Do NOT break the 4th wall or reference game mechanics, scores, or tips
• Do NOT start with "I" — vary your sentence openers
• You have memory: earlier turns in this conversation are things YOU already said this ride — reference, escalate, or contradict them naturally as a real person would`
}

function buildUserPrompt(eventType, fare, extraData) {
  const type = fare.passengerType || 'STANDARD'

  switch (eventType) {
    case 'boarding':
      return `You have just been matched with a taxi that is on its way to pick you up. \
You haven't been picked up yet but you're aware a driver is coming. \
Generate a short voice line — as if speaking to yourself or into a phone — \
that reveals your personality, hints at how you want to be driven, and sets the scene. \
Keep it natural and in-character.`

    case 'boarded':
      return `You have just gotten into the taxi. The driver is about to start the trip. \
Say something brief as you settle in. You can mention the vehicle, express anticipation or relief, \
or make a small comment that establishes your mood for the journey. \
Stay completely in character.`

    case 'halfway': {
      const rq = fare.rideQuality || {}
      const smoothness  = rq.smoothness        != null ? rq.smoothness.toFixed(2)        : null
      const aggEvents   = rq.aggressiveEvents  != null ? rq.aggressiveEvents              : null
      const efficiency  = rq.efficiency        != null ? rq.efficiency.toFixed(2)         : null
      const thrillData  = rq.thrillData || {}
      const avgG        = thrillData.avgG       != null ? thrillData.avgG.toFixed(2)       : null
      const maxG        = thrillData.maxG       != null ? thrillData.maxG.toFixed(2)       : null

      let qualityLines = 'Driving quality data so far:\n'
      if (smoothness  != null) qualityLines += `  • Smoothness:         ${smoothness}/1.0 (1.0 = perfectly smooth)\n`
      if (aggEvents   != null) qualityLines += `  • Aggressive events:  ${aggEvents} (hard brakes/acceleration spikes)\n`
      if (efficiency  != null) qualityLines += `  • Efficiency score:   ${efficiency}/1.0\n`
      if (avgG        != null) qualityLines += `  • Average G-force:    ${avgG} G\n`
      if (maxG        != null) qualityLines += `  • Peak G-force:       ${maxG} G\n`
      if (smoothness == null && aggEvents == null) qualityLines += '  (no detailed data available)\n'

      return `You are approximately halfway through the ride. \
${qualityLines}
React to the driving quality so far with a single candid comment. \
Based on your personality, you might complain, compliment, express nerves, show excitement, \
or drop a dry observation. Do not summarise all the stats — just react naturally.`
    }

    case 'speedCamera': {
      const spd   = extraData && extraData.playerSpeedKmh ? `${extraData.playerSpeedKmh} km/h` : 'too fast'
      const limit = extraData && extraData.speedLimitKmh  ? `${extraData.speedLimitKmh} km/h zone` : 'a speed zone'
      return `The driver just triggered a speed camera — doing ${spd} in a ${limit}. \
A flash went off. React immediately in character. \
Depending on your personality, you might be alarmed, amused, annoyed, impressed, or worried about the fine.`
    }

    case 'policeChase': {
      const level = extraData && extraData.wantedLevel ? extraData.wantedLevel : 1
      return `Police are now actively pursuing this taxi (wanted level: ${level}). \
You are in the back seat. React immediately in character — \
this could mean panic, excitement, anger, nervous laughter, or shouting directions depending on who you are.`
    }

    case 'crash': {
      const sev = extraData && extraData.severity ? extraData.severity : 'moderate'
      return `The taxi just had a ${sev} impact — a noticeable crash or collision. \
You felt it in the back seat. React immediately in character — \
shock, fear, anger, dark humour, adrenaline, whatever fits your personality.`
    }

    case 'farewell': {
      const rq = fare.rideQuality || {}
      const smoothness = rq.smoothness != null ? rq.smoothness.toFixed(2) : null
      const aggEvents  = rq.aggressiveEvents != null ? rq.aggressiveEvents : null
      const totalFare  = fare.totalFare ? formatMoney(fare.totalFare) : formatMoney(fare.baseFare)
      const distDriven = fare.totalDistance ? formatDistance(fare.totalDistance) : null

      let rideReport = 'Ride summary:\n'
      if (distDriven)    rideReport += `  • Distance driven: ${distDriven}\n`
      rideReport += `  • Final fare: ${totalFare}\n`
      if (smoothness != null)  rideReport += `  • Smoothness: ${smoothness}/1.0\n`
      if (aggEvents  != null)  rideReport += `  • Rough events: ${aggEvents}\n`

      return `You have just arrived at your destination. The ride is over. \
${rideReport}
Say a brief, in-character farewell that reflects your overall satisfaction (or dissatisfaction) with the ride. \
Reference something specific you mentioned earlier in the ride — the car, an incident, your first impression — \
and let your final judgement either confirm or contradict it. Keep it natural and sharp.`
    }

    default:
      return 'Say a brief, in-character comment appropriate to the current moment of the ride.'
  }
}

// ============================================================
// PRE-GENERATION
// ============================================================
// Generic user prompts for reactive events — no specific data (speed, wanted level, etc.)
// since we don't know what will happen yet.  Good enough for instant playback.
function buildPreGenUserPrompt(eventType) {
  switch (eventType) {
    case 'policeChase':
      return `Police suddenly start chasing this taxi. You are in the back seat and it just became obvious. \
React immediately in character — whatever that means for you.`
    case 'crash':
      return `The taxi has just had a significant crash or collision. You felt it hard from the back seat. \
React immediately in character.`
    case 'speedCamera':
      return `A speed camera just flashed as the taxi sped past a speed trap. \
React immediately in character — alarmed, amused, annoyed, impressed, whatever fits.`
    default:
      return 'Something unexpected just happened during the ride. React in character.'
  }
}

// Silently pre-generate audio for the three reactive event types after the passenger boards.
// Results are stored in preGenCache[eventType] = { script, audioBuffer }.
// If an event fires before pre-gen finishes, it falls back to live generation.
async function preGenerateReactiveAudio(fare, voice) {
  const PREGEN_EVENTS = ['policeChase', 'crash', 'speedCamera']
  dbg('Pre-generation starting for:', PREGEN_EVENTS.join(', '))

  for (const eventType of PREGEN_EVENTS) {
    if (!isEventEnabled(eventType)) continue
    if (preGenCache[eventType]) continue   // already cached (shouldn't happen but be safe)

    try {
      const userPrompt = buildPreGenUserPrompt(eventType)
      const messages = [
        { role: 'system', content: rideSystemPrompt },
        ...conversationHistory,
        { role: 'user', content: userPrompt },
      ]

      const script = await callLLM(messages)
      if (!script) { dbg(`Pre-gen: empty script for ${eventType}`); continue }

      const audioBuffer = await synthesizeSpeech(script, voice.voiceId)
      preGenCache[eventType] = { script, audioBuffer, userPrompt }
      dbg(`Pre-gen cached: ${eventType} — "${script}"`)
    } catch (err) {
      // Silent failure — event will fall back to live generation
      dbg(`Pre-gen failed for ${eventType}:`, err.message || err)
    }
  }

  dbg(`Pre-generation complete. Cached: ${Object.keys(preGenCache).join(', ') || 'none'}`)
}

// ============================================================
// LLM API
// ============================================================
// messages: full array including system message and all prior turns
async function callLLM(messages) {
  const llm  = config.llm
  const base = buildLLMBaseUrl()
  const url  = `${base}/chat/completions`
  const model = llm.model || 'local-model'

  TV_LOG(`→ LLM call: POST ${url}  model=${model}  messages=${messages.length}  (last role: ${messages[messages.length-1]?.role})`)

  const body = {
    model,
    max_tokens:  llm.maxTokens   || 150,
    temperature: llm.temperature || 0.92,
    messages,
  }

  let resp
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${llm.apiKey || 'lm-studio'}`,
      },
      body: JSON.stringify(body),
    })
  } catch (networkErr) {
    TV_LOG(`✗ LLM network error (is your LLM server running?): ${networkErr.message}`)
    throw networkErr
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    TV_LOG(`✗ LLM HTTP ${resp.status}: ${errText.slice(0, 300)}`)
    throw new Error(`LLM API ${resp.status}: ${errText.slice(0, 200)}`)
  }

  const json = await resp.json()
  const text = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content
  const result = text ? text.trim() : null
  TV_LOG(`✓ LLM response: "${result}"`)
  return result
}

// ============================================================
// ELEVENLABS TTS
// ============================================================
async function synthesizeSpeech(text, voiceId) {
  const el  = config.elevenlabs
  const fmt = el.outputFormat || 'mp3_44100_128'
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=${fmt}`
  TV_LOG(`→ ElevenLabs TTS: voiceId=${voiceId}  text="${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"  model=${el.modelId || 'eleven_turbo_v2_5'}`)

  const body = {
    text:       text,
    model_id:   el.modelId || 'eleven_turbo_v2_5',
    voice_settings: {
      stability:         0.5,
      similarity_boost:  0.8,
      style:             0.0,
      use_speaker_boost: true,
    },
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key':   el.apiKey,
    },
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    TV_LOG(`✗ ElevenLabs HTTP ${resp.status}: ${errText.slice(0, 300)}`)
    throw new Error(`ElevenLabs API ${resp.status}: ${errText.slice(0, 200)}`)
  }

  // Stream: collect all chunks into a single ArrayBuffer
  const reader = resp.body.getReader()
  const chunks = []
  let totalLength = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    totalLength += value.length
  }

  const combined = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.length
  }

  return combined.buffer
}

// ============================================================
// AUDIO PLAYBACK — with car interior spatial effect
// ============================================================

// Cached impulse response buffer — built once, reused for every clip
let carIRBuffer = null

// Builds a synthetic car-interior impulse response programmatically.
// Models a small hard-surfaced enclosure (~1.5m x 1.3m x 1.1m):
//   - Short pre-delay (direct sound arrives first)
//   - Fast early reflections off glass/metal surfaces
//   - Rapid exponential decay (~180ms RT60)
//   - Slight high-frequency absorption (glass + upholstery)
function buildCarInteriorIR(ctx) {
  const sr       = ctx.sampleRate
  const duration = 0.22           // total IR length in seconds (car cabins are very short)
  const decay    = 18.0           // exponential decay rate — higher = faster, dryer room
  const preDelay = Math.floor(sr * 0.002)   // 2ms gap before first reflection
  const length   = Math.floor(sr * duration)

  const ir = ctx.createBuffer(2, length, sr)

  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch)

    // Direct sound impulse at pre-delay offset
    if (preDelay < length) data[preDelay] = ch === 0 ? 0.9 : 0.85

    // Early reflections: sparse spikes in the first 30ms simulating
    // bounces off windscreen, door glass, and headliner
    const earlyMs = [8, 12, 18, 24, 30]
    for (const ms of earlyMs) {
      const idx = preDelay + Math.floor(sr * ms / 1000)
      if (idx < length) {
        const attenuation = Math.exp(-decay * ms / 1000)
        // Slight left/right asymmetry for a sense of width
        data[idx] = (ch === 0 ? 0.6 : 0.5) * attenuation * (Math.random() * 0.3 + 0.85)
      }
    }

    // Diffuse tail: exponentially decaying noise after 35ms
    const tailStart = preDelay + Math.floor(sr * 0.035)
    for (let i = tailStart; i < length; i++) {
      const t = (i - tailStart) / sr
      data[i] += (Math.random() * 2 - 1) * 0.15 * Math.exp(-decay * t)
    }
  }

  return ir
}

function getAudioContext() {
  if (!audioContext) {
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)()
    } catch (e) {
      console.error('[TaxiVoice] AudioContext creation failed:', e)
      return null
    }
  }
  if (audioContext.state === 'suspended') {
    audioContext.resume().catch(() => {})
  }
  return audioContext
}

function enqueueAudio(arrayBuffer) {
  audioQueue.push(arrayBuffer)
  if (!isPlayingAudio) drainAudioQueue()
}

function drainAudioQueue() {
  if (audioQueue.length === 0) {
    isPlayingAudio = false
    return
  }
  isPlayingAudio = true
  playAudioBuffer(audioQueue.shift(), drainAudioQueue)
}

function playAudioBuffer(arrayBuffer, onEnded) {
  const ctx = getAudioContext()
  if (!ctx) { onEnded && onEnded(); return }

  ctx.decodeAudioData(arrayBuffer.slice(0), function (decoded) {
    const source = ctx.createBufferSource()
    source.buffer = decoded

    // ── Car interior DSP chain ───────────────────────────────────────────
    // source → lowpass (softens highs through upholstery/glass)
    //        → convolver (short room reflections)
    //        → dry/wet mix (keeps voice intelligible)
    //        → gain (volume)
    //        → destination

    const lowpass = ctx.createBiquadFilter()
    lowpass.type            = 'lowpass'
    lowpass.frequency.value = 3800    // Hz — cuts the brightest air, keeps warmth
    lowpass.Q.value         = 0.7

    // Subtle presence dip around 2kHz (windscreen/headliner absorption)
    const presence = ctx.createBiquadFilter()
    presence.type            = 'peaking'
    presence.frequency.value = 2000
    presence.gain.value      = -2.5   // dB
    presence.Q.value         = 1.2

    // Build IR buffer once and cache it
    if (!carIRBuffer) {
      carIRBuffer = buildCarInteriorIR(ctx)
      dbg('Car interior IR built and cached')
    }

    const convolver = ctx.createConvolver()
    convolver.buffer    = carIRBuffer
    convolver.normalize = true

    // Dry/wet blend — too much reverb kills intelligibility; 25% wet is plenty for a car
    const dryGain = ctx.createGain()
    dryGain.gain.value = 0.80

    const wetGain = ctx.createGain()
    wetGain.gain.value = 0.25

    const masterGain = ctx.createGain()
    masterGain.gain.setValueAtTime(
      Math.max(0, Math.min(1, (config && config.volume) || 0.85)),
      ctx.currentTime
    )

    // Wire it up
    source.connect(lowpass)
    lowpass.connect(presence)

    presence.connect(dryGain)       // dry path
    dryGain.connect(masterGain)

    presence.connect(convolver)     // wet path
    convolver.connect(wetGain)
    wetGain.connect(masterGain)

    masterGain.connect(ctx.destination)

    source.onended = function () { onEnded && onEnded() }
    source.start(0)

    dbg(`Playing audio with car interior effect, duration: ${decoded.duration.toFixed(1)}s`)
  }, function (err) {
    console.error('[TaxiVoice] decodeAudioData error:', err)
    onEnded && onEnded()
  })
}

// ============================================================
// MAIN PIPELINE
// ============================================================
async function handleVoiceEvent(eventType, fare, extraData) {
  if (!config || !config.enabled) return
  if (!isEventEnabled(eventType)) {
    dbg(`Event "${eventType}" is disabled in config`)
    return
  }

  const voice = getVoiceEntry(fare.passengerType || 'STANDARD')
  if (!voice) {
    dbg(`No voice configured for passenger type: ${fare.passengerType}`)
    return
  }

  dbg(`Pipeline start: ${eventType} | type=${fare.passengerType} | voice=${voice.name} (${voice.voiceId})`)
  dbg(`Conversation history: ${conversationHistory.length} turns so far`)

  // Build (or reuse) the ride-level system prompt before anything else.
  // This must happen early so pre-gen can use it.
  if (!rideSystemPrompt) {
    rideSystemPrompt = buildSystemPrompt(eventType, fare, voice)
    dbg('System prompt built for this fare')
  }

  // ── REACTIVE EVENTS: serve from pre-gen cache if available ──────────────
  const REACTIVE_EVENTS = ['policeChase', 'crash', 'speedCamera']
  if (REACTIVE_EVENTS.includes(eventType) && preGenCache[eventType]) {
    const cached = preGenCache[eventType]
    delete preGenCache[eventType]   // consume — one-use per ride
    dbg(`Serving "${eventType}" from pre-gen cache (instant playback)`)

    // Add both sides to conversation history so future turns have context
    conversationHistory.push({ role: 'user',      content: cached.userPrompt })
    conversationHistory.push({ role: 'assistant', content: cached.script     })

    enqueueAudio(cached.audioBuffer)
    return
  }

  // ── NORMAL PATH: live LLM + TTS ─────────────────────────────────────────
  try {
    const userPrompt = buildUserPrompt(eventType, fare, extraData)

    // Append this turn to history BEFORE calling so the AI receives it as the latest user message
    conversationHistory.push({ role: 'user', content: userPrompt })

    // Full message thread: system prompt + every prior user/assistant turn + this user turn
    const messages = [
      { role: 'system', content: rideSystemPrompt },
      ...conversationHistory,
    ]

    dbg(`Calling LLM for "${eventType}" with ${messages.length} messages...`)
    const script = await callLLM(messages)
    if (!script) {
      TV_LOG('✗ LLM returned empty script — aborting event', eventType)
      conversationHistory.pop()
      return
    }

    // Store the assistant's response so future turns can reference it
    conversationHistory.push({ role: 'assistant', content: script })
    TV_LOG(`✓ Script stored in history (turn ${conversationHistory.length})`)

    // Persist to file via Lua if saveResponses is enabled
    if (config.saveResponses !== false) {
      try {
        const api = getApi()
        if (api) {
          api.engineLua(
            `if gameplay_taxiVoice then gameplay_taxiVoice.saveAIResponse(` +
            `${JSON.stringify(eventType)},${JSON.stringify(fare.passengerType || '')},` +
            `${JSON.stringify(voice.name || '')},${JSON.stringify(script)}) end`
          )
        }
      } catch (_) {}
    }

    TV_LOG('→ Calling ElevenLabs TTS...')
    const audioBuffer = await synthesizeSpeech(script, voice.voiceId)
    TV_LOG(`✓ TTS audio received: ${audioBuffer.byteLength} bytes — queuing playback`)

    enqueueAudio(audioBuffer)
  } catch (err) {
    // Graceful degradation — never surface errors to the player
    // Roll back the user turn if the call failed so history stays clean
    if (conversationHistory.length && conversationHistory[conversationHistory.length - 1].role === 'user') {
      conversationHistory.pop()
    }
    TV_LOG(`✗ Pipeline error for "${eventType}":`, err.message || err)
  }
}

// ============================================================
// HALFWAY TRACKING
// ============================================================
function initHalfwayTracking(fare) {
  halfwayFired = false
  halfwayTarget = 0

  const estDist = getEstimatedDistance(fare)
  if (estDist > 0) {
    halfwayTarget = estDist / 2
    dbg(`Halfway tracking init: target=${halfwayTarget.toFixed(0)}m (est total=${(estDist).toFixed(0)}m)`)
  }
}

function checkHalfway(fare) {
  if (halfwayFired || halfwayTarget <= 0) return
  const driven = fare.totalDistance || 0
  if (driven >= halfwayTarget) {
    halfwayFired = true
    dbg(`Halfway point reached: driven=${driven.toFixed(0)}m, target=${halfwayTarget.toFixed(0)}m`)
    handleVoiceEvent('halfway', fare, null)
  }
}

// ============================================================
// STATE MACHINE
// ============================================================
function resetRideState() {
  halfwayTarget       = 0
  halfwayFired        = false
  rideContext         = null
  conversationHistory = []
  rideSystemPrompt    = null
  Object.keys(reactiveCooldowns).forEach(k => delete reactiveCooldowns[k])
  Object.keys(preGenCache).forEach(k => delete preGenCache[k])
  // IR buffer is intentionally NOT cleared — it's cheap to keep and expensive to rebuild
  dbg('Ride state reset (conversation history + pre-gen cache cleared)')
}

function notifyLuaRideState(active) {
  const api = getApi()
  if (api) {
    api.engineLua(`if gameplay_taxiVoice then gameplay_taxiVoice.setInRide(${active}) end`)
  }
}

function fetchRideContext() {
  const api = getApi()
  if (api) {
    api.engineLua('if gameplay_taxiVoice then gameplay_taxiVoice.requestContext() end')
  }
}

function onTaxiStateUpdate(data) {
  if (!configLoaded || !config || !config.enabled) return

  const newState = data && data.state
  const fare     = data && data.currentFare
  const fp       = fareFingerprint(fare)
  const isNewFare = fp !== null && fp !== lastFareFingerprint

  if (fare) currentFare = Object.assign({}, fare, {
    vehicleMultiplier: data.vehicleMultiplier || fare.vehicleMultiplier,
  })

  // Detect transitions
  if (lastState !== newState || isNewFare) {
    TV_LOG(`State transition: ${lastState} → ${newState}${isNewFare ? ' (new fare)' : ''}  fare=${fare && fare.passengerType || 'none'}`)

    // accept→pickup: player accepted the fare, driving to pick up passenger
    // Generate "boarding" clip now so it's ready by the time they arrive
    if (newState === 'pickup' && lastState !== 'pickup') {
      if (isNewFare) resetRideState()
      fetchRideContext()
      // Small delay to let context response arrive before building the prompt
      window.setTimeout(() => {
        if (currentFare) handleVoiceEvent('boarding', currentFare, null)
      }, 800)
    }

    // pickup→dropoff: passenger just got in the car
    else if (newState === 'dropoff' && lastState === 'pickup') {
      handleVoiceEvent('boarded', fare, null)
      initHalfwayTracking(fare)
      notifyLuaRideState(true)

      // Kick off background pre-generation for reactive events (police/crash/speedCamera)
      // if the flag is enabled.  Runs async so it never blocks gameplay.
      if (config.preGenerateReactiveEvents) {
        const voice = getVoiceEntry(fare.passengerType || 'STANDARD')
        if (voice) {
          // Delay slightly so rideSystemPrompt is guaranteed to be set
          // (handleVoiceEvent above sets it on first call)
          window.setTimeout(() => {
            preGenerateReactiveAudio(fare, voice)
          }, 200)
        }
      }
    }

    // dropoff→complete: arrived at destination
    else if (newState === 'complete' && lastState === 'dropoff') {
      notifyLuaRideState(false)
      handleVoiceEvent('farewell', fare, null)
    }

    // Ended without completing (cancelled, disabled, etc.)
    else if ((newState === 'ready' || newState === 'start' || newState === 'disabled') &&
             (lastState === 'dropoff' || lastState === 'pickup')) {
      notifyLuaRideState(false)
    }
  }

  // Halfway check runs on every dropoff-state update (fare.totalDistance updates frequently)
  if (newState === 'dropoff' && fare) {
    checkHalfway(fare)
  }

  lastState = newState
  if (isNewFare) lastFareFingerprint = fp
  if (newState === 'start' || newState === 'ready') lastFareFingerprint = null
}

// ============================================================
// REACTIVE EVENTS FROM LUA
// ============================================================
function onTaxiVoiceEvent(data) {
  if (!configLoaded || !config || !config.enabled) return
  if (lastState !== 'dropoff') return  // only react while passenger is in car

  const eventType = data && data.event
  if (!eventType) return

  if (!canFireReactive(eventType)) {
    dbg(`Reactive event "${eventType}" throttled (cooldown active)`)
    return
  }

  dbg(`Reactive event received: ${eventType}`, data)
  const fare = currentFare || {}
  handleVoiceEvent(eventType, fare, data)
}

// ============================================================
// CONFIG & CONTEXT RECEIVERS
// ============================================================
function onConfigReceived(data) {
  if (data && typeof data === 'object') {
    config = data
    configLoaded = true
    const llmDesc = data.llm
      ? `${data.llm.host || data.llm.baseUrl || '?'}:${data.llm.port || ''}${data.llm.path || '/v1'}`
      : 'none'
    TV_LOG(`✓ Config received from Lua | enabled=${config.enabled} | llm=${llmDesc} | model=${data.llm && data.llm.model}`)
    // Immediately log the resolved URL so the user can verify it
    TV_LOG(`  Resolved LLM URL: ${buildLLMBaseUrl()}/chat/completions`)
  } else {
    TV_LOG('✗ Config received but data was empty or wrong type:', data)
  }
}

function onContextReceived(data) {
  if (data && typeof data === 'object') {
    rideContext = data
    TV_LOG(`✓ Context received: vehicle="${data.vehicleDisplayName}" map="${data.mapDisplayName}" time="${data.timeLabel} ${data.timeStr}"`)
  }
}

// ============================================================
// ANGULAR MODULE INITIALISATION
// Exact pattern from cardGamesPrompt.js:64-95
// ============================================================
function initializeModule($rootScope) {
  // Config from Lua
  $rootScope.$on('taxiVoiceConfig', function (event, data) {
    onConfigReceived(data)
  })

  // Context (map/time/vehicle) from Lua
  $rootScope.$on('taxiVoiceContext', function (event, data) {
    onContextReceived(data)
  })

  // Main taxi state — same channel the taxi phone app listens to
  $rootScope.$on('updateTaxiState', function (event, data) {
    onTaxiStateUpdate(data)
  })

  // Reactive events pushed from Lua (police, crash, speed camera)
  $rootScope.$on('taxiVoiceEvent', function (event, data) {
    onTaxiVoiceEvent(data)
  })

  // Request config on startup; slight delay so gameplay_taxiVoice extension is loaded
  window.setTimeout(function () {
    const api = getApi()
    if (api) {
      TV_LOG('Requesting config from Lua...')
      api.engineLua('if gameplay_taxiVoice then gameplay_taxiVoice.requestConfig() else print("[TaxiVoice] gameplay_taxiVoice extension NOT FOUND") end')
    } else {
      TV_LOG('✗ bngApi not available — module may be running outside BeamNG')
    }
  }, 1500)

  TV_LOG('Module initialised. Listening for: updateTaxiState, taxiVoiceConfig, taxiVoiceContext, taxiVoiceEvent')
}

const taxiVoiceModule = angular.module('taxiVoice', ['ui.router'])

.run(function () {
  console.log('[TaxiVoice] Angular .run() fired — attempting DOM mount')

  function initializeOverlay() {
    const bodyElement = angular.element(document.body)
    const injector = bodyElement.injector()
    if (!injector) {
      console.log('[TaxiVoice] Injector not ready, retrying in 100ms...')
      window.setTimeout(initializeOverlay, 100)
      return
    }

    console.log('[TaxiVoice] Injector found, mounting module')
    const $rootScope = injector.get('$rootScope')
    initializeModule($rootScope)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeOverlay)
  } else {
    window.setTimeout(initializeOverlay, 300)
  }
})

export default taxiVoiceModule
