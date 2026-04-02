#!/bin/bash
# VoiceMPP Daily Health Test — paid TTS + STT via agentcash, report to Telegram

BOT_TOKEN="${TELEGRAM_BOT_TOKEN}"
CHAT_ID="${TELEGRAM_CHAT_ID}"
BASE_URL="https://voicempp.shelmail.xyz"
MAX_RETRIES=3
RETRY_DELAY=30

# Random delay 0-30 minutes to avoid predictable patterns
RANDOM_DELAY=$((RANDOM % 1800))
echo "Sleeping ${RANDOM_DELAY}s before running..."
sleep $RANDOM_DELAY

send_telegram() {
  local msg="$1"
  curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -d "chat_id=${CHAT_ID}" \
    -d "parse_mode=Markdown" \
    -d "text=${msg}" > /dev/null 2>&1
}

test_health() {
  local response=$(curl -s -w "\n%{http_code}" "${BASE_URL}/api/health")
  local http_code=$(echo "$response" | tail -1)
  if [ "$http_code" = "200" ]; then echo "OK"; return 0; fi
  echo "FAIL|HTTP${http_code}"
  return 1
}

test_tts_paid() {
  local attempt=1
  while [ $attempt -le $MAX_RETRIES ]; do
    local start=$(date +%s%N)
    local result=$(npx -y agentcash@latest fetch "${BASE_URL}/api/tts" \
      -m POST \
      -H "Content-Type: application/json" \
      -b '{"text":"VoiceMPP daily health check. Testing text to speech.","voice":"en_US-amy-medium"}' \
      --max-amount 0.05 2>&1)
    local end=$(date +%s%N)
    local duration_ms=$(( (end - start) / 1000000 ))

    local success=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('success',False))" 2>/dev/null)
    local tx=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('metadata',{}).get('payment',{}).get('transactionHash','none'))" 2>/dev/null)
    local price=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('metadata',{}).get('price','?'))" 2>/dev/null)

    if [ "$success" = "True" ]; then
      echo "OK|${duration_ms}ms|${price}|${tx}|attempt${attempt}"
      return 0
    fi

    echo "TTS attempt $attempt failed" >&2
    attempt=$((attempt + 1))
    [ $attempt -le $MAX_RETRIES ] && sleep $RETRY_DELAY
  done
  echo "FAIL|${MAX_RETRIES}attempts|none"
  return 1
}

test_stt_demo() {
  # Generate audio first, then transcribe
  local attempt=1

  # Generate test audio via demo TTS
  curl -s -o /tmp/voicempp-daily.wav -X POST "${BASE_URL}/api/demo/tts" \
    -H "Content-Type: application/json" \
    -d '{"text":"Daily health check for speech to text.","voice":"en_US-ryan-medium"}'

  if [ ! -f /tmp/voicempp-daily.wav ] || [ $(stat -c%s /tmp/voicempp-daily.wav 2>/dev/null || echo 0) -lt 1000 ]; then
    echo "FAIL|no audio generated|none"
    return 1
  fi

  while [ $attempt -le $MAX_RETRIES ]; do
    local start=$(date +%s%N)
    local response=$(curl -s -w "\n%{http_code}" \
      -X POST "${BASE_URL}/api/demo/stt" \
      -F "file=@/tmp/voicempp-daily.wav" \
      -F "language=en")
    local end=$(date +%s%N)
    local duration_ms=$(( (end - start) / 1000000 ))
    local http_code=$(echo "$response" | tail -1)
    local body=$(echo "$response" | head -n -1)
    local text=$(echo "$body" | python3 -c "import sys,json; print(json.load(sys.stdin).get('text',''))" 2>/dev/null)

    if [ "$http_code" = "200" ] && [ -n "$text" ]; then
      echo "OK|${duration_ms}ms|${text}|attempt${attempt}"
      rm -f /tmp/voicempp-daily.wav
      return 0
    fi

    attempt=$((attempt + 1))
    [ $attempt -le $MAX_RETRIES ] && sleep $RETRY_DELAY
  done
  rm -f /tmp/voicempp-daily.wav
  echo "FAIL|HTTP${http_code}|${MAX_RETRIES}attempts"
  return 1
}

# --- Run tests ---
timestamp=$(date '+%Y-%m-%d %H:%M UTC')

health_result=$(test_health)
tts_result=$(test_tts_paid)
stt_result=$(test_stt_demo)

# Parse TTS
tts_status=$(echo "$tts_result" | cut -d'|' -f1)
tts_time=$(echo "$tts_result" | cut -d'|' -f2)
tts_price=$(echo "$tts_result" | cut -d'|' -f3)
tts_tx=$(echo "$tts_result" | cut -d'|' -f4)

# Parse STT
stt_status=$(echo "$stt_result" | cut -d'|' -f1)
stt_time=$(echo "$stt_result" | cut -d'|' -f2)
stt_text=$(echo "$stt_result" | cut -d'|' -f3)

# Count
passes=0
[ "$health_result" = "OK" ] && passes=$((passes + 1))
[ "$tts_status" = "OK" ] && passes=$((passes + 1))
[ "$stt_status" = "OK" ] && passes=$((passes + 1))

if [ $passes -eq 3 ]; then
  header="VoiceMPP Daily Report - ALL PASS"
else
  header="VoiceMPP Daily Report - ${passes}/3 PASS"
fi

# Shorten tx hash for display
tts_tx_short="none"
if [ -n "$tts_tx" ] && [ "$tts_tx" != "none" ]; then
  tts_tx_short="${tts_tx:0:10}...${tts_tx: -8}"
fi

msg="${header}
${timestamp}

Health: ${health_result}
TTS (paid): ${tts_status} (${tts_time}, ${tts_price})
  tx: ${tts_tx_short}
STT (demo): ${stt_status} (${stt_time})
  transcript: ${stt_text}

${BASE_URL}"

# Add explorer link if tx exists
if [ -n "$tts_tx" ] && [ "$tts_tx" != "none" ]; then
  msg="${msg}
https://explore.tempo.xyz/tx/${tts_tx}"
fi

send_telegram "$msg"
echo "Report sent: ${passes}/3 passed"
