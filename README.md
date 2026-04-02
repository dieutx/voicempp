# VoiceMPP

Fully self-hosted Voice-as-a-Service via Tempo micropayments. Pay-per-request TTS and STT over the Machine Payments Protocol (MPP).

**Zero external API dependencies.** All inference runs locally using Piper TTS and whisper.cpp.

**Live demo:** https://voicempp.shelmail.xyz
**OpenAPI spec:** https://voicempp.shelmail.xyz/openapi.json
**MPPscan:** registered on [mppscan.com](https://www.mppscan.com)

## Endpoints

| Method | Path | Price | Description |
|--------|------|-------|-------------|
| POST | `/api/tts` | $0.05/request | Text to WAV audio (paid via MPP) |
| POST | `/api/stt` | $0.01/request | Audio to text transcript (paid via MPP) |
| POST | `/api/demo/tts` | Free | TTS demo (500 char limit) |
| POST | `/api/demo/stt` | Free | STT demo (5MB limit) |
| GET | `/api/voices` | Free | List available TTS voices |
| GET | `/api/health` | Free | Service health check |
| GET | `/openapi.json` | Free | OpenAPI 3.1.0 discovery spec |

## Tech Stack

| Component | Technology |
|-----------|-----------|
| TTS engine | [Piper](https://github.com/rhasspy/piper) — ONNX neural TTS, CPU |
| STT engine | [whisper.cpp](https://github.com/ggerganov/whisper.cpp) — C++ Whisper, CPU |
| Payments | [mppx](https://github.com/wevm/mppx) SDK — Tempo USDC |
| Server | Node.js + TypeScript (raw HTTP, no framework) |
| Discovery | OpenAPI 3.1.0 + MPPscan compatible |

## Setup Guide

### Prerequisites

- Node.js 20+
- ffmpeg (`apt install ffmpeg`)
- cmake + build-essential (for whisper.cpp)
- A Tempo wallet private key

### 1. Clone and install

```bash
git clone https://github.com/dieutx/voicempp.git
cd voicempp
npm install
```

### 2. Install Piper TTS

```bash
mkdir -p bin models
# Download Piper binary
wget -q https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz -O /tmp/piper.tar.gz
tar xzf /tmp/piper.tar.gz -C /tmp
cp /tmp/piper/piper bin/piper
cp /tmp/piper/lib* bin/ 2>/dev/null
cp -r /tmp/piper/espeak-ng-data bin/ 2>/dev/null

# Download voice models (add as many as you want from https://rhasspy.github.io/piper-samples/)
wget -q https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/amy/medium/en_US-amy-medium.onnx -O models/en_US-amy-medium.onnx
wget -q https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/amy/medium/en_US-amy-medium.onnx.json -O models/en_US-amy-medium.onnx.json
wget -q https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/ryan/medium/en_US-ryan-medium.onnx -O models/en_US-ryan-medium.onnx
wget -q https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/ryan/medium/en_US-ryan-medium.onnx.json -O models/en_US-ryan-medium.onnx.json
```

### 3. Build whisper.cpp

```bash
git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git /tmp/whisper
cd /tmp/whisper && cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j$(nproc)
cp build/bin/whisper-cli /path/to/voicempp/bin/whisper-cli
cd /path/to/voicempp

# Download Whisper model
wget -q https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin -O models/ggml-base.bin
```

### 4. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:
```
PRIVATE_KEY=<your tempo wallet private key, hex>
MPP_SECRET_KEY=<any random hex string, e.g. openssl rand -hex 16>
PORT=3000
```

### 5. Run

```bash
# Development
LD_LIBRARY_PATH=bin npm run dev

# Production
npm run build
LD_LIBRARY_PATH=bin npm start
```

### Docker (alternative)

```bash
cp .env.example .env
# Edit .env
docker compose up --build
```

Docker automatically downloads Piper, whisper.cpp, and all models.

### Systemd service (production)

```ini
[Unit]
Description=VoiceMPP
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/voicempp
Environment=LD_LIBRARY_PATH=/path/to/voicempp/bin
EnvironmentFile=/path/to/voicempp/.env
ExecStart=/usr/bin/node dist/server.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## Usage

### With mppx CLI

```bash
# TTS (paid)
mppx POST https://voicempp.shelmail.xyz/api/tts \
  -d '{"text":"Hello!","voice":"en_US-amy-medium","speed":1.0}'

# STT (paid)
mppx POST https://voicempp.shelmail.xyz/api/stt \
  -F file=@recording.wav
```

### With agentcash

```bash
npx agentcash try https://voicempp.shelmail.xyz
npx agentcash fetch "https://voicempp.shelmail.xyz/api/tts" \
  -m POST -H "Content-Type: application/json" \
  -b '{"text":"Hello!","voice":"en_US-amy-medium"}' --max-amount 0.05
```

### With mppx SDK (TypeScript)

```typescript
import { Mppx, tempo } from "mppx/client";
import { privateKeyToAccount } from "viem/accounts";

const mppx = Mppx.create({
  methods: [tempo({ account: privateKeyToAccount("0x...") })],
});

// TTS
const ttsRes = await mppx.fetch("https://voicempp.shelmail.xyz/api/tts", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text: "Hello!", voice: "en_US-amy-medium" }),
});
const audio = await ttsRes.arrayBuffer(); // WAV binary

// STT
const form = new FormData();
form.append("file", audioBlob, "recording.wav");
const sttRes = await mppx.fetch("https://voicempp.shelmail.xyz/api/stt", {
  method: "POST",
  body: form,
});
const { text, language, duration } = await sttRes.json();
```

## TTS Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `text` | string | required | Text to synthesize (max 5000 chars) |
| `voice` | string | `en_US-amy-medium` | Voice ID from `/api/voices` |
| `speed` | number | 1.0 | 0.25 (slow) to 4.0 (fast) |
| `noiseScale` | number | 0.667 | Expressiveness (0=monotone, 1=expressive) |
| `noiseW` | number | 0.8 | Phoneme variation (higher=more natural) |
| `sentenceSilence` | number | 0.2 | Pause between sentences (seconds) |
| `speaker` | integer | 0 | Speaker ID for multi-speaker models |

## Adding Voices

Drop Piper ONNX models into `models/` — auto-discovered on startup:

```bash
# Example: add German voice
wget -q https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx -O models/de_DE-thorsten-medium.onnx
wget -q https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx.json -O models/de_DE-thorsten-medium.onnx.json
# Restart server to pick up new voice
```

Browse all voices: https://rhasspy.github.io/piper-samples/

## Performance

| Task | Latency | Notes |
|------|---------|-------|
| TTS (100 chars) | ~250ms | 15x faster than real-time |
| TTS (500 chars) | ~500ms | Scales linearly |
| STT (5s audio) | ~1.3s | whisper base model |
| STT (30s audio) | ~5s | 16 CPU cores |

## Payment Flow

```
Client                          VoiceMPP
  |                                |
  |--- POST /api/tts ------------->|
  |                                |
  |<-- 402 + WWW-Authenticate -----|  (payment challenge)
  |                                |
  |--- Pay USDC on Tempo --------->|  (on-chain transfer)
  |                                |
  |--- POST /api/tts + credential->|  (retry with proof)
  |                                |
  |<-- 200 + WAV audio ------------|  (done)
```

## License

MIT
