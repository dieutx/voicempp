# VoiceMPP — Hackathon Submission

## One-liner

Fully self-hosted voice service — TTS and STT via Tempo micropayments, zero external APIs.

## Description

VoiceMPP is a pay-per-use voice service over MPP. Text-to-speech and speech-to-text with all processing running locally on the server. No external API keys, no rate limits, no third-party dependencies.

Uses Piper TTS (neural ONNX) and whisper.cpp (C++ Whisper) for fast, high-quality inference on CPU.

## Key Features

- **Text-to-Speech**: 9 neural voices across 8 languages, ~250ms generation
- **Speech-to-Text**: Whisper-based transcription, ~1s for 5s audio
- **Fully Local**: All inference on CPU, no GPU needed, no external API calls
- **MPP Native**: Standard HTTP 402 payment flow with mppx SDK
- **Micropayment pricing**: TTS $0.05/request, STT $0.01/request
- **OpenAPI Discovery**: `/openapi.json` for MPPscan registration
- **Docker Deploy**: One command to run anywhere

## Category

Developer Tools

## Links

- Demo: https://voicempp.shelmail.xyz
- GitHub: https://github.com/dieutx/voicempp
- OpenAPI: https://voicempp.shelmail.xyz/openapi.json
