import { execFile } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "node:crypto";
import { cpus } from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_DIR = path.join(__dirname, "..", "bin");
const MODELS_DIR = path.join(__dirname, "..", "models");
const WHISPER_BIN = path.join(BIN_DIR, "whisper-cli");
const WHISPER_MODEL = path.join(MODELS_DIR, "ggml-base.bin");

export interface STTResult {
  text: string;
  language: string;
  duration: number;
}

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB

// whisper.cpp requires 16kHz mono WAV. Convert any audio to that format using ffmpeg if available.
async function convertToWav(inputPath: string): Promise<string> {
  const outPath = inputPath + ".16k.wav";
  return new Promise<string>((resolve, reject) => {
    execFile(
      "ffmpeg",
      ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-f", "wav", outPath],
      { timeout: 30000 },
      (err) => {
        if (err) {
          // If ffmpeg not available, hope the file is already compatible
          resolve(inputPath);
          return;
        }
        resolve(outPath);
      }
    );
  });
}

export async function transcribe(
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string,
  language?: string
): Promise<STTResult> {
  if (fileBuffer.length > MAX_FILE_SIZE) {
    throw new Error("File size exceeds maximum of 25MB");
  }

  // Write buffer to temp file
  const ALLOWED_EXTS = new Set(["mp3", "wav", "m4a", "webm", "ogg", "flac"]);
  const rawExt = (fileName.match(/\.(\w+)$/)?.[1] || "wav").toLowerCase();
  const ext = ALLOWED_EXTS.has(rawExt) ? rawExt : "bin";
  const tmpFile = path.join(tmpdir(), `voicempp-stt-${randomUUID()}.${ext}`);
  writeFileSync(tmpFile, fileBuffer);

  // Convert to 16kHz WAV for whisper.cpp
  const wavFile = await convertToWav(tmpFile);

  const filesToClean = [tmpFile];
  if (wavFile !== tmpFile) filesToClean.push(wavFile);

  try {
    const result = await new Promise<STTResult>((resolve, reject) => {
      const args = [
        "-m", WHISPER_MODEL,
        "-f", wavFile,
        "--no-timestamps",
        "-t", String(Math.min(8, Math.max(1, Math.floor(cpus().length / 2)))),
      ];
      if (language) {
        args.push("-l", language);
      }

      execFile(
        WHISPER_BIN,
        args,
        { timeout: 120000 },
        (err, stdout, stderr) => {
          if (err) {
            console.error("whisper-cli error:", err.message);
            reject(new Error("Speech recognition failed"));
            return;
          }

          const text = stdout.trim();

          // Parse timing from stderr
          let duration = 0;
          const totalMatch = stderr.match(/total time\s*=\s*([\d.]+)\s*ms/);
          if (totalMatch) {
            duration = parseFloat(totalMatch[1]) / 1000;
          }

          // Parse detected language
          let detectedLang = language || "en";
          const langMatch = stderr.match(/auto-detected language:\s*(\w+)/);
          if (langMatch) {
            detectedLang = langMatch[1];
          }

          resolve({ text, language: detectedLang, duration });
        }
      );
    });

    return result;
  } finally {
    for (const f of filesToClean) {
      try { unlinkSync(f); } catch {}
    }
  }
}
