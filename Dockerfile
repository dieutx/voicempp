FROM node:20-slim AS builder

# Install build dependencies for whisper.cpp
RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake build-essential git wget ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Build whisper.cpp
RUN git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git /tmp/whisper \
    && cd /tmp/whisper \
    && cmake -B build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build -j$(nproc) \
    && cp build/bin/whisper-cli /app/whisper-cli

# Download Piper TTS
RUN wget -q https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz -O /tmp/piper.tar.gz \
    && tar xzf /tmp/piper.tar.gz -C /tmp \
    && cp /tmp/piper/piper /app/piper \
    && cp -r /tmp/piper/lib* /app/ 2>/dev/null || true \
    && cp -r /tmp/piper/espeak-ng-data /app/ 2>/dev/null || true

# Download models
RUN mkdir -p /app/models \
    # Whisper STT model
    && wget -q https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin -O /app/models/ggml-base.bin \
    # English voices
    && wget -q https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/amy/medium/en_US-amy-medium.onnx -O /app/models/en_US-amy-medium.onnx \
    && wget -q https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/amy/medium/en_US-amy-medium.onnx.json -O /app/models/en_US-amy-medium.onnx.json \
    && wget -q https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/ryan/medium/en_US-ryan-medium.onnx -O /app/models/en_US-ryan-medium.onnx \
    && wget -q https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/ryan/medium/en_US-ryan-medium.onnx.json -O /app/models/en_US-ryan-medium.onnx.json \
    # Chinese
    && wget -q https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx -O /app/models/zh_CN-huayan-medium.onnx \
    && wget -q https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx.json -O /app/models/zh_CN-huayan-medium.onnx.json \
    # French
    && wget -q https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/fr/fr_FR/siwis/medium/fr_FR-siwis-medium.onnx -O /app/models/fr_FR-siwis-medium.onnx \
    && wget -q https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/fr/fr_FR/siwis/medium/fr_FR-siwis-medium.onnx.json -O /app/models/fr_FR-siwis-medium.onnx.json \
    # German
    && wget -q https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx -O /app/models/de_DE-thorsten-medium.onnx \
    && wget -q https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx.json -O /app/models/de_DE-thorsten-medium.onnx.json \
    # Spanish
    && wget -q https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/es/es_ES/davefx/medium/es_ES-davefx-medium.onnx -O /app/models/es_ES-davefx-medium.onnx \
    && wget -q https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/es/es_ES/davefx/medium/es_ES-davefx-medium.onnx.json -O /app/models/es_ES-davefx-medium.onnx.json \
    # Vietnamese
    && wget -q https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/vi/vi_VN/vais1000/medium/vi_VN-vais1000-medium.onnx -O /app/models/vi_VN-vais1000-medium.onnx \
    && wget -q https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/vi/vi_VN/vais1000/medium/vi_VN-vais1000-medium.onnx.json -O /app/models/vi_VN-vais1000-medium.onnx.json \
    # Portuguese Brazilian
    && wget -q https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/pt/pt_BR/faber/medium/pt_BR-faber-medium.onnx -O /app/models/pt_BR-faber-medium.onnx \
    && wget -q https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/pt/pt_BR/faber/medium/pt_BR-faber-medium.onnx.json -O /app/models/pt_BR-faber-medium.onnx.json \
    # Russian
    && wget -q https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/ru/ru_RU/denis/medium/ru_RU-denis-medium.onnx -O /app/models/ru_RU-denis-medium.onnx \
    && wget -q https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/ru/ru_RU/denis/medium/ru_RU-denis-medium.onnx.json -O /app/models/ru_RU-denis-medium.onnx.json

# --- Runtime stage ---
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy binaries and models from builder
COPY --from=builder /app/piper /app/bin/piper
COPY --from=builder /app/whisper-cli /app/bin/whisper-cli
COPY --from=builder /app/lib* /app/bin/
COPY --from=builder /app/espeak-ng-data /app/bin/espeak-ng-data
COPY --from=builder /app/models /app/models

# Copy app
COPY package*.json ./
RUN npm ci --production

COPY tsconfig.json ./
COPY src/ ./src/
COPY public/ ./public/

RUN npx tsc

ENV LD_LIBRARY_PATH=/app/bin
EXPOSE 3000

CMD ["node", "dist/server.js"]
