# RLS Taxi Voice

AI-generated passenger dialogue for the **RLS Career Overhaul** taxi system.  
Passengers speak in character when you pick them up, react mid-ride to your driving, and respond to police chases, speed cameras, and crashes — all synthesised in real-time with ElevenLabs TTS.

---

## Requirements

| Requirement | Notes |
|---|---|
| **BeamNG.drive** | v0.32 or later recommended |
| **RLS Career Overhaul** | v2.6.0 or later — this mod does nothing without it |
| **LLM API** | OpenAI, LMStudio (local), Ollama, or any OpenAI-compatible endpoint |
| **ElevenLabs API** | Free tier works; Starter tier recommended for lower latency |

---

## Installation

### Step 1 — Install the mod

**Option A: ZIP install (recommended)**
1. Zip the `rls_taxi_voice` folder → `rls_taxi_voice.zip`
2. Drop `rls_taxi_voice.zip` into your BeamNG mods folder:
   ```
   Documents\BeamNG.drive\mods\
   ```
3. Launch BeamNG and enable the mod in **Main Menu → Mods**

**Option B: Folder install (development)**
1. Copy the entire `rls_taxi_voice` folder directly into:
   ```
   Documents\BeamNG.drive\mods\
   ```

### Step 2 — Install the config file

Copy `settings/taxiVoice.json` from inside the mod to your BeamNG settings folder:
```
Documents\BeamNG.drive\settings\taxiVoice.json
```
This is where you add your API keys. The file inside the mod zip is a read-only template.

### Step 3 — Add your API keys

Open `Documents\BeamNG.drive\settings\taxiVoice.json` in any text editor and fill in:

```json
{
    "enabled": true,
    "llm": {
        "baseUrl": "https://api.openai.com/v1",
        "apiKey": "sk-YOUR_OPENAI_KEY_HERE",
        "model": "gpt-4o-mini"
    },
    "elevenlabs": {
        "apiKey": "YOUR_ELEVENLABS_KEY_HERE"
    }
}
```

Set `"enabled": true` when you're ready to use it.

---

## LLM Options

### OpenAI (default)
```json
"llm": {
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-...",
    "model": "gpt-4o-mini"
}
```
`gpt-4o-mini` is fast and cheap. `gpt-4o` produces noticeably better character writing.

### LMStudio (local, free) — default config
Run any GGUF model locally — no API costs, works offline.
1. Download [LMStudio](https://lmstudio.ai)
2. Load a model (Mistral 7B Instruct or better recommended)
3. Start the local server (default port 1234)
4. Config is pre-set for this — just make sure `enabled: true`:
```json
"llm": {
    "host":   "127.0.0.1",
    "port":   1234,
    "path":   "/v1",
    "apiKey": "lm-studio",
    "model":  "local-model"
}
```

### Ollama (local, free)
1. Install [Ollama](https://ollama.ai) and pull a model: `ollama pull mistral`
2. Set in config:
```json
"llm": {
    "host":   "127.0.0.1",
    "port":   11434,
    "path":   "/v1",
    "apiKey": "ollama",
    "model":  "mistral"
}
```

### OpenAI
```json
"llm": {
    "host":   "api.openai.com",
    "path":   "/v1",
    "https":  true,
    "apiKey": "sk-...",
    "model":  "gpt-4o-mini"
}
```

---

## Voice Setup

Voices are assigned per passenger type in `taxiVoice.json`. The defaults use ElevenLabs premade voices. To use your own:

1. Go to [ElevenLabs Voice Library](https://elevenlabs.io/voice-library) and add voices to your account
2. Find the Voice ID (click a voice → "Voice ID" in the sidebar)
3. Update the relevant entry in `"voices"`:
```json
"voices": {
    "THRILL": { "voiceId": "YOUR_VOICE_ID_HERE", "enabled": true }
}
```

### Voice Library metadata
Each voice in `"voiceLibrary"` has `gender`, `age`, `accent`, and `style` tags.  
These are passed to the LLM so it can write dialogue appropriate to the voice — a teen voice gets different vocabulary than a deep authoritative one. Keep these accurate if you add your own voices.

### Disabling voices per type
Set `"enabled": false` for any passenger type to skip audio for that type:
```json
"voices": {
    "STANDARD": { "voiceId": "...", "enabled": false }
}
```

---

## When Does It Play?

| Moment | What happens |
|---|---|
| You accept a fare | Passenger intro generates in the background (30–90s lead time) |
| You arrive at pickup | "Settling in" remark as they board |
| ~Halfway to destination | Mid-ride comment based on your actual driving quality |
| Speed camera triggered | Immediate passenger reaction |
| Police chase begins | Immediate reaction to being pursued |
| Crash / significant impact | Immediate reaction to the hit |
| You arrive at destination | Farewell — reflects the whole ride, references earlier comments |

Passengers **remember** what they said earlier in the ride. The farewell may directly contradict or confirm something from the boarding — that's intentional.

---

## Options

All options are in `Documents\BeamNG.drive\settings\taxiVoice.json`.

| Option | Default | Description |
|---|---|---|
| `enabled` | `false` | Master on/off switch |
| `llm.model` | `gpt-4o-mini` | LLM model to use |
| `llm.maxTokens` | `150` | Max tokens per response (controls dialogue length) |
| `llm.temperature` | `0.92` | Creativity — higher = more varied, lower = more consistent |
| `elevenlabs.modelId` | `eleven_turbo_v2_5` | ElevenLabs model — `eleven_turbo_v2_5` is fastest |
| `volume` | `0.85` | Playback volume (0.0–1.0) |
| `preGenerateReactiveEvents` | `false` | Pre-generate police/crash/speed camera audio at ride start so it plays instantly. Uses extra API credits even if events don't happen. |
| `halfwayRoadFactor` | `1.35` | Multiplier on straight-line distance to estimate actual road distance for halfway detection |
| `crashDamageThreshold` | `0.08` | How hard a hit needs to be to trigger a crash reaction |
| `debugLogging` | `false` | Log pipeline events to the F8 console |

### Disabling specific events
```json
"enabledEvents": {
    "boarding":    true,
    "boarded":     true,
    "halfway":     true,
    "speedCamera": false,
    "policeChase": false,
    "crash":       true,
    "farewell":    true
}
```

---

## Debugging

Open the BeamNG F8 console and filter for `TaxiVoice`. You should see this sequence on a working install:

```
[TaxiVoice] ===== taxiVoice.js loaded at 2025-xx-xx =====
[TaxiVoice] Angular .run() fired — attempting DOM mount
[TaxiVoice] Injector found, mounting module
[TaxiVoice] Module initialised. Listening for: updateTaxiState ...
[TaxiVoice] Requesting config from Lua...
[TaxiVoice] ✓ Config received from Lua | enabled=true | llm=127.0.0.1:1234/v1 | model=local-model
[TaxiVoice]   Resolved LLM URL: http://127.0.0.1:1234/v1/chat/completions
```

Then on a taxi ride:
```
[TaxiVoice] State transition: accept → pickup  fare=THRILL
[TaxiVoice] → LLM call: POST http://127.0.0.1:1234/v1/chat/completions  model=local-model
[TaxiVoice] ✓ LLM response: "Oh man, finally a proper car — floor it!"
[TaxiVoice] → ElevenLabs TTS: voiceId=...
[TaxiVoice] ✓ TTS audio received: 84320 bytes — queuing playback
```

Log files are written to `Documents\BeamNG.drive\settings\taxiVoiceLog\`:
- `session.json` — full event timeline
- `responses.json` — every AI-generated script with timestamps

## Troubleshooting

**Script loads but no config received**
- The Lua extension `gameplay_taxiVoice` didn't load. Check F8 for `=== RLS Taxi Voice extension loading ===`
- Confirm both mods are enabled in BeamNG's mod manager
- Check that `settings/taxiVoice.json` exists in `Documents\BeamNG.drive\settings\`

**Config received but no LLM call**
- Check `"enabled": true` in your settings file
- Confirm you are in career mode with RLS Career Overhaul active (not freeroam without career)

**"LLM network error (is your LLM server running?)"**
- LMStudio server is not started, or is on a different port
- Check LMStudio → Local Server → server address matches `host:port` in config

**"LLM HTTP 404"**
- Wrong `path` — LMStudio default is `/v1`, verify in LMStudio's server settings

**"LLM HTTP 401"**
- API key wrong or expired (for cloud providers)

**"ElevenLabs HTTP 401"**
- Wrong `elevenlabs.apiKey`

**"ElevenLabs HTTP 400/422"**
- Voice ID doesn't exist in your ElevenLabs account — check `voices.[TYPE].voiceId`

**Audio plays but LLM gives repetitive lines**
- Increase `llm.temperature` (try `0.95`)
- Use a more capable model

**Game performance impact**
- API calls are async and never block gameplay
- If ElevenLabs is slow, audio plays a few seconds after the event — network/tier issue, not the mod

---

## Compatibility

- **RLS Career Overhaul**: Required. Zero changes made to its files.
- **Other BeamNG mods**: Should be fully compatible — this mod only listens to existing events.
- **Multiplayer**: Not tested. Likely fine since it's client-side audio only.

---

## Credits

Mod by [your name].  
Built as a companion to [RLS Career Overhaul](https://www.beamng.com/resources/rls-career-overhaul.28563/) by Raceless & Tristan.
