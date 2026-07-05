<p align="center">
  <img src="./public/logo.png" alt="Logo" width="65" />
</p>

# Massist

<p align="center">
  <a href="https://shirsendu-bairagi.betteruptime.com">
    <img src="https://uptime.betterstack.com/status-badges/v3/monitor/10aqw.svg" alt="Uptime Status">
  </a>
</p>

![Landing](public/previews/landing.webp)

> An AI-powered assistant service integrating tools to automate workflows, answer queries, and orchestrate actions across the platform.

# Quickstart

A quickstart example project that shows you how to scaffold a cross-language project, compose Python and TypeScript workers, and incrementally add functionality to a live system with zero downtime.

| Worker          | Language   | Function                | Does                                     |
| --------------- | ---------- | ----------------------- | ---------------------------------------- |
| `math-worker`   | Python     | `math::add`             | Returns `{ c: a + b }`                   |
| `caller-worker` | TypeScript | `math::add_two_numbers` | Calls `math::add` and returns the result |

Continue with the tutorial at: https://iii.dev/docs/quickstart

### Local Multimodal AI Stack (RTX 5060 Ti 16GB)

Text, Image, Audio, Video Modals

---

| Layer                         | Model                                          | Runtime       | VRAM  | Use Cases                                                                                                                             |
| ----------------------------- | ---------------------------------------------- | ------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **🧠 Text to Text**           | `Qwen/Qwen3.5-4B`                              | vLLM          | ~8GB  | Caption generation, media tagging, shoot briefs, client proposals, blog drafts, hashtag strategy                                      |
| **🎨 Image to Text (Vision)** | `Qwen/Qwen3.5-4B`                              | vLLM          | ~8GB  | Auto-tag uploaded assets, extract scene metadata, product recognition, shoot analysis                                                 |
| **👂 Speech to Text**         | `Canary-Qwen STT`                              | GPU / CPU     | ~2GB  | Transcribe client calls, meeting notes, voice briefs, podcast to blog, interview subtitles                                            |
| **🎬 Video to Text**          | `Qwen/Qwen3.5-4B`                              | vLLM          | ~8GB  | Auto-generate video descriptions, extract shot list, SEO metadata, subtitle export — same model handles 1hr+ video                    |
| ----------------------------- | ---------------------------------------------- | ------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **🎨 Text to Image**          | `Tongyi-MAI/Z-Image-Turbo`                     | vLLM `--omni` | ~8GB  | Product mockups, mood boards, campaign concept art, social media visuals, background generation                                       |
| **🎨 Image to Image (Edit)**  | `black-forest-labs/FLUX.1-Kontext-dev`         | diffusers     | ~12GB | Background removal, style transfer, product retouching, color grading — runs comfortably on 16GB VRAM                                 |
| **👂 Speech to Image**        | `Canary-Qwen` → `Qwen3.5-4B` → `Z-Image-Turbo` | Pipeline      | swap  | Voice-driven mood board creation — cascade STT → prompt enhancement → image gen                                                       |
| **🎬 Video to Image**         | `Qwen/Qwen3.5-4B` + FFmpeg                     | vLLM          | ~14GB | Extract keyframes, auto-generate thumbnails, pull hero stills with AI-selected best frame                                             |
| ----------------------------- | ---------------------------------------------- | ------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **🗣️ Text to Speech**         | `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice`         | vLLM `--omni` | <1GB  | Brand voiceovers, video narration, podcast intros, ad read generation, reel audio                                                     |
| **🎨 Image to Audio**         | `hkchengrex/MMAudio`                           | diffusers     | ~4GB  | Generate ambient sound matching a visual mood, auto-score for reels — supports experimental image-to-audio by duplicating input image |
| **👂 Speech to Speech**       | `Canary-Qwen STT` → `Qwen3-TTS`                | Pipeline      | ~3GB  | Real-time voice translation for multilingual clients — cascade STT + TTS, no single end-to-end model yet                              |
| **🎬 Video to Audio**         | `hkchengrex/MMAudio`                           | diffusers     | ~4GB  | Isolate/generate voiceover, background score, audio cleanup — CVPR 2025, synced audio from video + text prompts                       |
| ----------------------------- | ---------------------------------------------- | ------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **🎬 Text to Video**          | `Lightricks/LTX-Video-2.3`                     | diffusers     | ~12GB | Product showcase clips, social media reels, brand story videos — runs on GPUs with as little as 12GB VRAM                             |
| **🎨 Image to Video**         | `Wan-AI/Wan2.2-I2V-A14B`                       | vLLM `--omni` | ~14GB | Animate product photos, bring mood boards to life — industry-first MoE I2V model, superior motion consistency                         |
| **👂 Speech to Video**        | `Canary-Qwen` → `Qwen3.5-4B` → `LTX-Video 2.3` | Pipeline      | swap  | Talking head videos from voice brief — cascade STT → script → video                                                                   |
| **🎬 Video to Video**         | `Lightricks/LTX-Video-2.3`                     | diffusers     | ~12GB | Style transfer, color grade to brand palette — supports T2V, I2V, and V2V in one model                                                |

---

## GPU swap schedule on 16GB

```
Always loaded (tiny, coexist fine):
  Qwen3-TTS       < 1GB
  MMAudio         ~4GB
  Canary-Qwen     ~2GB

Profile: text (swap in)
  vLLM: Qwen3.5-4B + Qwen2.5-VL-7B   ~8-14GB

Profile: image (swap in)
  vLLM --omni: Z-Image-Turbo           ~8GB
  diffusers: FLUX.1-Kontext-dev        ~12GB

Profile: video (swap in)
  vLLM --omni: Wan2.2-I2V              ~14GB
  diffusers: LTX-Video 2.3             ~12GB
```

## Key observations

- FLUX.2 Klein 4B is now available at ~13GB VRAM as a future upgrade for image editing when you want one unified generation + editing model
- LTX-2 natively generates synchronized audio + video in one pass, making it better than Wan2.2 if audio sync matters more than cinematic quality
- Speech pipelines (Speech→Image, Speech→Video, Speech→Speech) are all cascades — no single local model does end-to-end yet, but the cascade latency is acceptable for async workflows

| Layer                | Tool                     | Runtime Location | VRAM / Resource Usage |
| -------------------- | ------------------------ | ---------------- | --------------------- |
| **🧠 Agent Logic**   | Qwen-Agent (MCP + tools) | CPU              | Calls VLLM            |
| **🗃️ Memory**        | Qdrant (Vector DB)       | System RAM       | RAM Dependent         |
| **📐 Embeddings**    | BGE-M3                   | CPU / GPU        | <1GB VRAM             |
| **🔍 Web Search**    | SearXNG (Self-hosted)    | CPU              | Dockerized            |
| **🌐 Scraping**      | Crawl4AI                 | CPU              | Python/Playwright     |
| **🤖 Orchestration** | Motia (Rust runtime)     | CPU              | Negligible            |

---

### Resource Strategy

| Mode              | Active Services                 | VRAM Status                                     |
| ----------------- | ------------------------------- | ----------------------------------------------- |
| **Always Loaded** | Qwen3.5 + Fish TTS + Embeddings | **~15GB / 16GB** (Tight but stable)             |
| **Swap Mode**     | Unload LLM ➔ Load FLUX or LTX   | **~12-16GB** (Utilizes fast PCIe reload)        |
| **System RAM**    | 32GB RAM Cache                  | Keeps inactive models "hot" for faster swapping |

---

### Quick Commands

> [!TIP]
> Use these profiles to manage your VRAM headspace effectively.

**For Text & Analysis (Default):**

```bash
docker compose --profile text up -d

```

**For Creative Work (Image/Video):**

```bash
docker compose --profile text down && docker compose --profile image up -d

```

## License

Published under the [MIT](https://github.com/Modest-Human-Brands/massist/blob/main/LICENSE) license.
<br><br>
<a href="https://github.com/Modest-Human-Brands/massist/graphs/contributors">
<img src="https://contrib.rocks/image?repo=Modest-Human-Brands/massist" />
</a>
