import { synthesize, listVoices } from "./tts.js";

async function main() {
  console.log("Testing voice list...");
  const voices = await listVoices();
  console.log(`Found ${voices.length} voices:`);
  voices.forEach((v) => console.log(`  ${v.id} — ${v.name} (${v.language}, ${v.gender})`));

  console.log("\nTesting TTS synthesis...");
  const start = Date.now();
  const buffer = await synthesize({ text: "Hello! This is VoiceMPP running fully locally with Piper TTS." });
  const elapsed = Date.now() - start;
  console.log(`Generated ${buffer.length} bytes in ${elapsed}ms`);

  const fs = await import("fs");
  fs.writeFileSync("/tmp/voicempp-piper-test.wav", buffer);
  console.log("Saved to /tmp/voicempp-piper-test.wav");
}

main().catch(console.error);
