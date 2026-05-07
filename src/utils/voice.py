from voxcpm import VoxCPM
import base64
import io
import soundfile as sf
import emoji
from omnivoice import OmniVoice
import torch


def strip_emojis(text):
    # replace_emoji removes emojis and returns the cleaned string
    return emoji.replace_emoji(text, replace="")


def design(text, voice_description, model="voxcpm"):
    if model == "voxcpm":
        model = VoxCPM.from_pretrained(
            "openbmb/VoxCPM2",
            load_denoiser=False,
        )
        audio = model.generate(
            text=text,
            cfg_value=2.0,
            inference_timesteps=10,
        )
        sf.write("./output.wav", audio, model.tts_model.sample_rate)
    elif model == "omnivoice":
        model = OmniVoice.from_pretrained(
            "k2-fsa/OmniVoice", device_map="cuda:0", dtype=torch.float16
        )
        audio = model.generate(
            text=text,
            instruct=voice_description,
        )  # audio is a list of `np.ndarray` with shape (T,) at 24 kHz
        sf.write("./output.wav", audio[0], 24000)


def clone(
    text, reference_audio_path, reference_audio_text, model="voxcpm", use_cpu=False
):
    if model == "voxcpm":
        model = VoxCPM.from_pretrained(
            "openbmb/VoxCPM2",
            load_denoiser=False,
        )
        # Note: If VoxCPM needs CPU support, you would typically add
        # .to("cpu") or specific device logic here as well.
        audio = model.generate(
            text=text,
            cfg_value=2.0,
            inference_timesteps=10,
        )
        sf.write("./artifact/output.wav", audio, model.tts_model.sample_rate)

    elif model == "omnivoice":
        # Determine device and dtype based on use_cpu flag
        device = "cpu" if use_cpu else "cuda:0"
        dtype = torch.float32 if use_cpu else torch.float16

        model = OmniVoice.from_pretrained(
            "k2-fsa/OmniVoice", device_map=device, dtype=dtype
        )
        audio = model.generate(
            text=text,
            ref_audio=reference_audio_path,
            ref_text=reference_audio_text,
        )  # audio is a list of `np.ndarray` with shape (T,) at 24 kHz
        sample_rate = 24000

        buffer = io.BytesIO()
        sf.write(buffer, audio[0], sample_rate, format="WAV")
        buffer.seek(0)

        sf.write("./artifact/output.wav", audio[0], sample_rate)

        # Return base64 string
        return base64.b64encode(buffer.read()).decode("utf-8")
