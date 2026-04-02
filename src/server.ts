import "dotenv/config";
import { createServer, IncomingMessage } from "node:http";
import { readFileSync } from "node:fs";
import path from "path";
import { fileURLToPath } from "url";
import { Mppx, tempo, Request as MppxRequest } from "mppx/server";
import { privateKeyToAccount } from "viem/accounts";
import { synthesize, listVoices } from "./tts.js";
import { transcribe } from "./stt.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");

// --- Config ---
const PORT = Number(process.env.PORT) || 3000;
const raw = process.env.PRIVATE_KEY || "";
const PRIVATE_KEY = (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;

if (!raw) {
  console.error("Missing PRIVATE_KEY env var");
  process.exit(1);
}

const account = privateKeyToAccount(PRIVATE_KEY);
// USDC on Tempo mainnet (chainId 4217) — compatible with AgentCash
const currency = "0x20c000000000000000000000b9537d11c60e8b50" as const;

// --- mppx setup ---
const mppx = Mppx.create({
  methods: [
    tempo({
      account,
      currency,
      recipient: account.address,
    }),
  ],
});

// --- Rate limiter ---
const rateLimits = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string, maxPerMinute: number): boolean {
  const now = Date.now();
  let entry = rateLimits.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 60_000 };
  }
  entry.count++;
  rateLimits.set(ip, entry);
  return entry.count <= maxPerMinute;
}

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimits) {
    if (now > entry.resetAt) rateLimits.delete(ip);
  }
}, 300_000);

// --- Concurrency limiter ---
let activeTTS = 0;
let activeSTT = 0;
const MAX_CONCURRENT_TTS = 4;
const MAX_CONCURRENT_STT = 2;

// --- Language validation ---
const VALID_LANG = /^[a-z]{2}$/;

// --- Security headers ---
function withHeaders(response: Response): Response {
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("Content-Security-Policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; media-src 'self' blob:;");
  return response;
}

// --- Multipart parser ---
async function parseMultipart(request: Request): Promise<{
  file?: { buffer: Buffer; name: string; type: string };
  fields: Record<string, string>;
}> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return { fields: {} };
  }

  const formData = await request.formData();
  const fields: Record<string, string> = {};
  let file: { buffer: Buffer; name: string; type: string } | undefined;

  for (const [key, value] of formData.entries()) {
    if (value instanceof File) {
      const arrayBuf = await value.arrayBuffer();
      file = {
        buffer: Buffer.from(arrayBuf),
        name: value.name || "audio.webm",
        type: value.type || "audio/webm",
      };
    } else {
      fields[key] = String(value);
    }
  }

  return { file, fields };
}

// --- OpenAPI spec (static, MPPscan/AgentCash compliant) ---
const openapiSpec = JSON.stringify({
  openapi: "3.1.0",
  info: {
    title: "VoiceMPP",
    version: "1.0.0",
    description: "Self-hosted Voice-as-a-Service. Text-to-speech (TTS) and speech-to-text (STT) paid per-request via Tempo Machine Payments Protocol (MPP). All inference runs locally using Piper TTS and whisper.cpp. 9 voices across 8 languages.",
    "x-guidance": "To use paid endpoints (/api/tts, /api/stt), send a request with MPP payment credentials. If no payment is provided, the server returns HTTP 402 with a WWW-Authenticate header containing the payment challenge. Use the mppx CLI or SDK to handle payment automatically. Free endpoints (/api/voices, /api/health) require no payment or authentication. For TTS, POST JSON with a 'text' field. For STT, POST multipart/form-data with an audio 'file' field. Call GET /api/voices first to discover available voice IDs.",
  },
  "x-discovery": {
    ownershipProofs: ["dns:voicempp.shelmail.xyz"],
  },
  servers: [{ url: "https://voicempp.shelmail.xyz" }],
  tags: [
    { name: "tts", description: "Text-to-speech synthesis" },
    { name: "stt", description: "Speech-to-text transcription" },
    { name: "discovery", description: "Service discovery and metadata" },
  ],
  paths: {
    "/api/tts": {
      post: {
        operationId: "textToSpeech",
        summary: "Convert text to speech audio",
        description: "Synthesize text into WAV audio using Piper TTS. Fixed price: $0.05 per request (up to 5000 characters). Supports 9 voices across 8 languages with configurable speed, expressiveness, and pausing.",
        tags: ["tts"],
        "x-payment-info": {
          pricingMode: "fixed",
          price: "0.050000",
          protocols: ["mpp"],
        },
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["text"],
                properties: {
                  text: { type: "string", maxLength: 5000, description: "Text to synthesize into speech. Maximum 5000 characters." },
                  voice: { type: "string", default: "en_US-amy-medium", description: "Voice model ID. Call GET /api/voices to list available voices." },
                  speed: { type: "number", minimum: 0.25, maximum: 4.0, default: 1.0, description: "Speech speed multiplier. 1.0 = normal, 0.5 = half speed, 2.0 = double speed." },
                  noiseScale: { type: "number", minimum: 0, maximum: 1, default: 0.667, description: "Controls expressiveness and emotion variation. 0 = monotone, 1 = very expressive." },
                  noiseW: { type: "number", minimum: 0, maximum: 1, default: 0.8, description: "Phoneme-level duration variation. Higher = more natural rhythm." },
                  sentenceSilence: { type: "number", minimum: 0, maximum: 5, default: 0.2, description: "Seconds of silence inserted between sentences." },
                  speaker: { type: "integer", minimum: 0, default: 0, description: "Speaker ID for multi-speaker voice models." },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "WAV audio file containing synthesized speech.",
            content: {
              "audio/wav": {
                schema: { type: "string", format: "binary" },
              },
            },
          },
          "400": {
            description: "Invalid request. Text is missing, empty, or exceeds 5000 characters.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { error: { type: "string", description: "Error message" } },
                },
              },
            },
          },
          "402": {
            description: "Payment Required. Returns MPP payment challenge in WWW-Authenticate header.",
          },
        },
      },
      get: {
        operationId: "textToSpeechProbe",
        summary: "TTS payment probe",
        description: "Returns 402 with payment challenge. Use POST with payment to synthesize speech.",
        tags: ["tts"],
        "x-payment-info": {
          pricingMode: "fixed",
          price: "0.050000",
          protocols: ["mpp"],
        },
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["text"],
                properties: {
                  text: { type: "string", maxLength: 5000, description: "Text to synthesize into speech. Maximum 5000 characters." },
                  voice: { type: "string", default: "en_US-amy-medium", description: "Voice model ID." },
                  speed: { type: "number", minimum: 0.25, maximum: 4.0, default: 1.0, description: "Speech speed multiplier." },
                },
              },
            },
          },
        },
        responses: {
          "402": { description: "Payment Required. Returns MPP payment challenge in WWW-Authenticate header." },
        },
      },
    },
    "/api/stt": {
      post: {
        operationId: "speechToText",
        summary: "Transcribe audio to text",
        description: "Transcribe an audio file to text using whisper.cpp. Fixed price: $0.01 per request. Supports mp3, wav, m4a, webm, ogg, flac formats up to 25MB.",
        tags: ["stt"],
        "x-payment-info": {
          pricingMode: "fixed",
          price: "0.010000",
          protocols: ["mpp"],
        },
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["file"],
                properties: {
                  file: { type: "string", format: "binary", description: "Audio file to transcribe. Supported: mp3, wav, m4a, webm, ogg, flac. Max 25MB." },
                  language: { type: "string", description: "ISO 639-1 language code hint (e.g. en, zh, fr, de, es, vi, pt, ru, ja, ko). Omit for auto-detection." },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Transcription result with detected language and processing duration.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["text", "language", "duration"],
                  properties: {
                    text: { type: "string", description: "Transcribed text content." },
                    language: { type: "string", description: "Detected or specified language code." },
                    duration: { type: "number", description: "Processing time in seconds." },
                  },
                },
              },
            },
          },
          "400": {
            description: "Invalid request. Audio file missing or exceeds size limit.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { error: { type: "string", description: "Error message" } },
                },
              },
            },
          },
          "402": {
            description: "Payment Required. Returns MPP payment challenge in WWW-Authenticate header.",
          },
        },
      },
      get: {
        operationId: "speechToTextProbe",
        summary: "STT payment probe",
        description: "Returns 402 with payment challenge. Use POST with payment and audio file to transcribe.",
        tags: ["stt"],
        "x-payment-info": {
          pricingMode: "fixed",
          price: "0.010000",
          protocols: ["mpp"],
        },
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["file"],
                properties: {
                  file: { type: "string", format: "binary", description: "Audio file (mp3, wav, m4a, webm, ogg, flac). Max 25MB." },
                  language: { type: "string", description: "ISO 639-1 language code hint." },
                },
              },
            },
          },
        },
        responses: {
          "402": { description: "Payment Required. Returns MPP payment challenge in WWW-Authenticate header." },
        },
      },
    },
  },
}, null, 2);

// --- Validate language for STT ---
function validateLanguage(lang: string | undefined): string | undefined {
  if (!lang) return undefined;
  const clean = lang.trim().toLowerCase();
  if (clean && VALID_LANG.test(clean)) return clean;
  return undefined;
}

// --- Request handler ---
async function handler(request: Request, clientIp: string): Promise<Response> {
  const url = new URL(request.url);

  // --- OpenAPI ---
  if (url.pathname === "/openapi.json") {
    return withHeaders(new Response(openapiSpec, {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    }));
  }

  // --- Well-known x402 discovery ---
  if (url.pathname === "/.well-known/x402") {
    return withHeaders(new Response(JSON.stringify({
      openapi: "/openapi.json",
      version: "1.0.0",
    }, null, 2), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    }));
  }

  // --- Static ---
  if (url.pathname === "/" || url.pathname === "/index.html") {
    const html = readFileSync(path.join(publicDir, "index.html"), "utf-8");
    return withHeaders(new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }));
  }

  if (url.pathname === "/favicon.svg") {
    const svg = readFileSync(path.join(publicDir, "favicon.svg"), "utf-8");
    return withHeaders(new Response(svg, {
      headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" },
    }));
  }

  // --- Free endpoints ---
  if (url.pathname === "/api/health") {
    return withHeaders(Response.json({ status: "ok", service: "voicempp", version: "1.0.0" }));
  }

  if (url.pathname === "/api/voices") {
    try {
      const voices = await listVoices();
      return withHeaders(Response.json({ voices }));
    } catch {
      return withHeaders(Response.json({ error: "Failed to list voices" }, { status: 500 }));
    }
  }

  // --- Demo TTS (free, rate-limited) ---
  if (url.pathname === "/api/demo/tts" && request.method === "POST") {
    if (!checkRateLimit(clientIp, 10)) {
      return withHeaders(Response.json({ error: "Rate limit exceeded, try again later" }, { status: 429 }));
    }
    if (activeTTS >= MAX_CONCURRENT_TTS) {
      return withHeaders(Response.json({ error: "Server busy, try again shortly" }, { status: 503 }));
    }
    try {
      const body = await request.text();
      const { text, voice, speed, noiseScale, noiseW, sentenceSilence } = JSON.parse(body || "{}");
      if (!text || typeof text !== "string") {
        return withHeaders(Response.json({ error: "text field is required" }, { status: 400 }));
      }
      if (text.length > 500) {
        return withHeaders(Response.json({ error: "Demo limited to 500 characters" }, { status: 400 }));
      }
      activeTTS++;
      try {
        const audioBuffer = await synthesize({ text, voice, speed, noiseScale, noiseW, sentenceSilence });
        return withHeaders(new Response(new Uint8Array(audioBuffer), {
          headers: { "Content-Type": "audio/wav", "Content-Length": audioBuffer.length.toString() },
        }));
      } finally {
        activeTTS--;
      }
    } catch (err: any) {
      console.error("Demo TTS error:", err);
      return withHeaders(Response.json({ error: "Speech synthesis failed" }, { status: 500 }));
    }
  }

  // --- Demo STT (free, rate-limited) ---
  if (url.pathname === "/api/demo/stt" && request.method === "POST") {
    if (!checkRateLimit(clientIp, 5)) {
      return withHeaders(Response.json({ error: "Rate limit exceeded, try again later" }, { status: 429 }));
    }
    if (activeSTT >= MAX_CONCURRENT_STT) {
      return withHeaders(Response.json({ error: "Server busy, try again shortly" }, { status: 503 }));
    }
    try {
      const { file, fields } = await parseMultipart(request);
      if (!file) {
        return withHeaders(Response.json({ error: "Audio file is required" }, { status: 400 }));
      }
      if (file.buffer.length > 5 * 1024 * 1024) {
        return withHeaders(Response.json({ error: "Demo limited to 5MB" }, { status: 400 }));
      }
      const lang = validateLanguage(fields.language);
      activeSTT++;
      try {
        const transcript = await transcribe(file.buffer, file.name, file.type, lang);
        return withHeaders(Response.json(transcript));
      } finally {
        activeSTT--;
      }
    } catch (err: any) {
      console.error("Demo STT error:", err);
      return withHeaders(Response.json({ error: "Transcription failed" }, { status: 500 }));
    }
  }

  // --- TTS: 405 for unsupported methods ---
  if (url.pathname === "/api/tts" && request.method !== "GET" && request.method !== "POST") {
    return withHeaders(new Response(null, { status: 405, headers: { "Allow": "GET, POST" } }));
  }

  // --- TTS (paid) — 402 on GET/POST, process on POST ---
  if (url.pathname === "/api/tts") {
    try {
      // Return 402 challenge before any body parsing
      const result = await mppx.charge({
        amount: "0.050000",
        description: "Text-to-speech (up to 5000 chars)",
      })(request);

      if (result.status === 402) return result.challenge;

      // Only POST allowed for actual processing
      if (request.method !== "POST") {
        return withHeaders(Response.json({ error: "Method not allowed. Use POST." }, { status: 405 }));
      }

      // Payment verified — now parse and validate body
      const body = await request.clone().text();
      const { text, voice, speed, noiseScale, noiseW, sentenceSilence, speaker } = JSON.parse(body || "{}");
      if (!text || typeof text !== "string") {
        return withHeaders(Response.json({ error: "text field is required" }, { status: 400 }));
      }
      if (text.length > 5000) {
        return withHeaders(Response.json({ error: "Text exceeds 5000 character limit" }, { status: 400 }));
      }

      if (activeTTS >= MAX_CONCURRENT_TTS) {
        return withHeaders(Response.json({ error: "Server busy" }, { status: 503 }));
      }
      activeTTS++;
      try {
        const audioBuffer = await synthesize({ text, voice, speed, noiseScale, noiseW, sentenceSilence, speaker });
        return result.withReceipt(
          new Response(new Uint8Array(audioBuffer), {
            headers: { "Content-Type": "audio/wav", "Content-Length": audioBuffer.length.toString() },
          })
        );
      } finally {
        activeTTS--;
      }
    } catch (err: any) {
      console.error("TTS error:", err);
      return withHeaders(Response.json({ error: "Speech synthesis failed" }, { status: 500 }));
    }
  }

  // --- STT: 405 for unsupported methods ---
  if (url.pathname === "/api/stt" && request.method !== "GET" && request.method !== "POST") {
    return withHeaders(new Response(null, { status: 405, headers: { "Allow": "GET, POST" } }));
  }

  // --- STT (paid) — 402 on GET/POST, process on POST ---
  if (url.pathname === "/api/stt") {
    try {
      // Return 402 challenge before any body parsing
      const result = await mppx.charge({
        amount: "0.010000",
        description: "Speech-to-text ($0.01/request)",
      })(request);

      if (result.status === 402) return result.challenge;

      if (request.method !== "POST") {
        return withHeaders(Response.json({ error: "Method not allowed. Use POST." }, { status: 405 }));
      }

      // Payment verified — now parse multipart
      const { file, fields } = await parseMultipart(request);
      if (!file) {
        return withHeaders(Response.json({ error: "Audio file is required" }, { status: 400 }));
      }
      if (file.buffer.length > 25 * 1024 * 1024) {
        return withHeaders(Response.json({ error: "File exceeds 25MB limit" }, { status: 400 }));
      }

      const lang = validateLanguage(fields.language);

      if (activeSTT >= MAX_CONCURRENT_STT) {
        return withHeaders(Response.json({ error: "Server busy" }, { status: 503 }));
      }
      activeSTT++;
      try {
        const transcript = await transcribe(file.buffer, file.name, file.type, lang);
        return result.withReceipt(withHeaders(Response.json(transcript)));
      } finally {
        activeSTT--;
      }
    } catch (err: any) {
      console.error("STT error:", err);
      return withHeaders(Response.json({ error: "Transcription failed" }, { status: 500 }));
    }
  }

  return withHeaders(new Response("Not Found", { status: 404 }));
}

// --- Extract client IP ---
function getClientIp(req: IncomingMessage): string {
  // Trust X-Real-IP set by nginx (not spoofable like X-Forwarded-For)
  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string") return realIp.trim();
  return req.socket.remoteAddress || "unknown";
}

// --- HTTP server ---
const server = createServer((req, res) => {
  const clientIp = getClientIp(req);
  const request = MppxRequest.fromNodeListener(req, res);
  handler(request, clientIp)
    .then((response) => {
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      if (response.body) {
        const reader = response.body.getReader();
        function pump(): Promise<void> {
          return reader.read().then(({ done, value }) => {
            if (done) { res.end(); return; }
            res.write(value);
            return pump();
          });
        }
        pump().catch(() => res.end());
      } else {
        res.end();
      }
    })
    .catch((err) => {
      console.error("Unhandled error:", err);
      res.writeHead(500);
      res.end("Internal Server Error");
    });
});

// --- Start ---
async function start() {
  server.listen(PORT, () => {
    console.log(`VoiceMPP running on port ${PORT}`);
  });
}

start();
