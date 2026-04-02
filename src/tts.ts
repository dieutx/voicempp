import { execFile } from "node:child_process";
import { readFileSync, unlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_DIR = path.join(__dirname, "..", "bin");
const MODELS_DIR = path.join(__dirname, "..", "models");
const PIPER_BIN = path.join(BIN_DIR, "piper");

export interface TTSRequest {
  text: string;
  voice?: string;
  speed?: number;          // 0.5 = half speed, 2.0 = double speed (maps to length_scale)
  noiseScale?: number;     // 0.0-1.0, expressiveness/variation (default 0.667)
  noiseW?: number;         // 0.0-1.0, phoneme width noise (default 0.8)
  sentenceSilence?: number; // seconds of silence between sentences (default 0.2)
  speaker?: number;        // speaker ID for multi-speaker models
}

export interface VoiceInfo {
  id: string;
  name: string;
  language: string;
  gender: string;
}

const MAX_TEXT_LENGTH = 5000;

function discoverVoices(): { id: string; modelPath: string; name: string; language: string; gender: string }[] {
  const files = readdirSync(MODELS_DIR).filter((f) => f.endsWith(".onnx") && !f.includes("ggml"));
  return files.map((f) => {
    const id = f.replace(".onnx", "");
    const parts = id.split("-");
    const lang = parts[0] || "en_US";
    const name = parts[1] ? parts[1].charAt(0).toUpperCase() + parts[1].slice(1) : id;
    const quality = parts[2] || "medium";
    let gender = "Unknown";
    try {
      const config = JSON.parse(readFileSync(path.join(MODELS_DIR, f + ".json"), "utf-8"));
      gender = config.speaker_id_map ? "Multi" : "Unknown";
      const femaleName = ["amy", "jenny", "aria", "sonia", "natasha", "denise", "elvira", "francisca", "siwis", "huayan", "kokoro", "vais1000", "kss"];
      const maleName = ["ryan", "guy", "keita", "yunxi", "thorsten", "davefx", "faber", "denis"];
      if (femaleName.includes(parts[1]?.toLowerCase())) gender = "Female";
      if (maleName.includes(parts[1]?.toLowerCase())) gender = "Male";
    } catch {}
    return {
      id,
      modelPath: path.join(MODELS_DIR, f),
      name: `${name} (${quality})`,
      language: lang.replace("_", "-"),
      gender,
    };
  });
}

let voiceCache: ReturnType<typeof discoverVoices> | null = null;

function getVoices() {
  if (!voiceCache) voiceCache = discoverVoices();
  return voiceCache;
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export async function synthesize(req: TTSRequest): Promise<Buffer> {
  if (!req.text || req.text.length === 0) {
    throw new Error("Text is required");
  }
  if (req.text.length > MAX_TEXT_LENGTH) {
    throw new Error(`Text exceeds maximum length of ${MAX_TEXT_LENGTH} characters`);
  }

  const voices = getVoices();
  const voice = voices.find((v) => v.id === req.voice) || voices[0];
  if (!voice) {
    throw new Error("No voice models found in models/ directory");
  }

  const outFile = path.join(tmpdir(), `voicempp-${randomUUID()}.wav`);

  // Build args with optional parameters
  const args = ["--model", voice.modelPath, "--output_file", outFile, "--quiet"];

  // speed: user sends 0.5-2.0, piper uses length_scale where <1 = faster, >1 = slower
  // So we invert: length_scale = 1/speed
  if (req.speed !== undefined) {
    const speed = clamp(req.speed, 0.25, 4.0);
    args.push("--length_scale", (1 / speed).toFixed(3));
  }

  if (req.noiseScale !== undefined) {
    args.push("--noise_scale", clamp(req.noiseScale, 0, 1).toFixed(3));
  }

  if (req.noiseW !== undefined) {
    args.push("--noise_w", clamp(req.noiseW, 0, 1).toFixed(3));
  }

  if (req.sentenceSilence !== undefined) {
    args.push("--sentence_silence", clamp(req.sentenceSilence, 0, 5).toFixed(2));
  }

  if (req.speaker !== undefined) {
    args.push("--speaker", String(Math.max(0, Math.floor(req.speaker))));
  }

  return new Promise<Buffer>((resolve, reject) => {
    const child = execFile(
      PIPER_BIN,
      args,
      {
        env: { ...process.env, LD_LIBRARY_PATH: BIN_DIR },
        timeout: 30000,
      },
      (err) => {
        const cleanup = () => { try { unlinkSync(outFile); } catch {} };
        if (err) {
          cleanup();
          reject(new Error("Speech synthesis failed"));
          return;
        }
        try {
          const wavBuffer = readFileSync(outFile);
          cleanup();
          resolve(wavBuffer);
        } catch {
          cleanup();
          reject(new Error("Failed to read synthesis output"));
        }
      }
    );

    child.stdin?.write(req.text);
    child.stdin?.end();
  });
}

export async function listVoices(): Promise<VoiceInfo[]> {
  return getVoices().map((v) => ({
    id: v.id,
    name: v.name,
    language: v.language,
    gender: v.gender,
  }));
}
