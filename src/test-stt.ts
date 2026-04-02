import { transcribe } from "./stt.js";
import { readFileSync } from "fs";

async function main() {
  console.log("Testing STT with Piper-generated WAV...");
  const buf = readFileSync("/tmp/voicempp-piper-test.wav");
  console.log(`Input: ${buf.length} bytes`);

  const start = Date.now();
  const result = await transcribe(buf, "test.wav", "audio/wav", "en");
  const elapsed = Date.now() - start;

  console.log(`Transcript: "${result.text}"`);
  console.log(`Language: ${result.language}`);
  console.log(`Processed in: ${elapsed}ms`);
}

main().catch(console.error);
