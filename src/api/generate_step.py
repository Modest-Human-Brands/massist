from typing import Any

from motia import ApiRequest, ApiResponse, FlowContext, http

# from audio.voice import design
from src.utils.voice import clone

config = {
    "name": "VoiceGenerate",
    "description": "Generate Voice",
    "flows": ["generate-voice-flow"],
    "triggers": [
        http("POST", "/api/generate/voice"),
    ],
    "enqueues": [],
}


async def handler(request: ApiRequest[Any], ctx: FlowContext[Any]) -> ApiResponse[Any]:
    text = request.body["text"]
    model = request.body["model"]

    audio_b64 = clone(
        text,
        "./artifact/audio-004-0003-001-mono.wav",
        "Hi, I am Anisha Paul, Durga Puja is not just a festival, it's an emotion",
        model,
        False,
    )

    return ApiResponse(
        status=200,
        body={
            "status": "success",
            "format": "wav",
            "encoding": "base64",
            "audio_content": audio_b64,
        },
    )
