"""Run the real API against a running project and save verified WAV files."""

import argparse
import io
import json
import urllib.error
import urllib.request
import wave
from pathlib import Path

import numpy as np

BASE_URL = "http://127.0.0.1:7860"
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
TEST_TEXT = "Hello, this is a test of the Kokoro text to speech system."
LONG_PARAGRAPHS = [
    (
        "On Saturday morning, Maya walked down to the harbor before the shops opened. "
        "A light wind moved the flags above the ferry terminal, and the smell of fresh bread "
        "drifted across the street. She had promised to meet her brother at the blue bench beside "
        "the ticket office. While she waited, she watched a crew carry boxes of oranges onto a small "
        "boat. Each box had a handwritten label, and every label listed a different island in the bay."
    ),
    (
        "When her brother arrived, he brought two cups of coffee and a map folded into a narrow square. "
        "Their plan was to take the first ferry, follow the coastal path, and reach the old lighthouse "
        "before noon. The map showed a second trail through a pine grove, so they decided to keep it "
        "in mind in case the weather changed. As the ferry pulled away, they counted the fishing boats "
        "and listened to the sound of the engine under the deck."
    ),
    (
        "The lighthouse stood at the end of a low stone wall. Its white paint was bright in the sun, "
        "and a bell rang from the village behind them. They ate their lunch on a flat rock overlooking "
        "the water and wrote down the names of the birds they could recognize. Before leaving, Maya took "
        "one last photograph of the red door. On the return trip, she printed the picture and tucked "
        "it into the map so they would remember where the day had taken them."
    ),
]


def call(path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(
        BASE_URL + path, data=data,
        headers={"Content-Type": "application/json"} if data else {},
    )
    try:
        with OPENER.open(request, timeout=240) as response:
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read()


def synthesize(text, voice, sample_rate, speed=1.0, save=None):
    status, headers, data = call("/api/tts", {"text": text, "voice": voice, "speed": speed})
    assert status == 200, (status, data[:500])
    assert headers.get_content_type() == "audio/wav"
    with wave.open(io.BytesIO(data)) as wav:
        assert (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) == (1, 2, sample_rate)
        assert wav.getnframes() > 0
        samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2")
        assert samples.size == wav.getnframes()
    peak = np.abs(samples.astype(np.int32)).max()
    assert peak > 100
    segments = int(headers["X-Kokoro-Segments"])
    if save:
        save.write_bytes(data)
        print(f"{save.name}: {len(samples) / sample_rate:.2f} s, {sample_rate} Hz, peak={peak}, segments={segments}", flush=True)
    return samples, segments


def energy(samples, window=480):
    count = len(samples) // window * window
    return np.log1p(np.mean(samples[:count].reshape(-1, window).astype(float) ** 2, axis=1))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--quick", action="store_true")
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).resolve().parents[1] / "outputs")
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    status, _, content = call("/api/health")
    health = json.loads(content)
    assert status == 200 and health["model_loaded"] and health["offline"], health
    sample_rate = health["sample_rate"]
    print(f"health: {health['model']}, {health['device']}, {sample_rate} Hz", flush=True)
    status, _, content = call("/api/voices")
    voices = json.loads(content)
    expected = {"af_heart": "a", "af_bella": "a", "af_nova": "a", "am_adam": "a",
                "am_echo": "a", "bf_emma": "b", "bm_george": "b"}
    assert status == 200 and voices["default"] == "af_heart", voices
    assert {voice["id"]: voice["lang_code"] for voice in voices["voices"]} == expected
    print("voices:", ", ".join(f"{name}={lang}" for name, lang in expected.items()), flush=True)

    for path, content_type, marker in (
        ("/", "text/html", b"LineEcho"),
        ("/tts", "text/html", b"Generate Speech"),
        ("/assets/style.css", "text/css", b".studio"),
        ("/assets/app.js", None, b"/api/tts"),
    ):
        status, headers, data = call(path)
        assert status == 200 and marker in data and (not content_type or headers.get_content_type() == content_type)
    for invalid in ({"text": " "}, {"text": "---"}, {"text": "A" * 12001},
                    {"text": TEST_TEXT, "speed": 1.4}, {"text": TEST_TEXT, "speed": "1.0"},
                    {"text": TEST_TEXT, "voice": "unknown"}):
        status, _, data = call("/api/tts", invalid)
        assert status == 422 and isinstance(json.loads(data)["detail"], str), (status, data[:500])
    print("home, CSS, JS and six input validation cases passed", flush=True)

    samples, _ = synthesize(
        TEST_TEXT, "af_heart", sample_rate,
        save=args.output_dir / ("kokoro-offline.wav" if args.quick else "kokoro-af_heart.wav"),
    )
    if args.quick:
        return

    for voice_id in expected:
        if voice_id != "af_heart":
            synthesize(TEST_TEXT, voice_id, sample_rate,
                       save=args.output_dir / f"kokoro-{voice_id}.wav" if voice_id in {"am_adam", "bf_emma"} else None)
    print("all seven voices generated non-silent WAVs", flush=True)
    slow, _ = synthesize(TEST_TEXT, "af_heart", sample_rate, speed=0.7)
    fast, _ = synthesize(TEST_TEXT, "af_heart", sample_rate, speed=1.3)
    assert len(slow) > len(samples) > len(fast)
    print(f"speed 0.7× / 1.0× / 1.3×: {[round(len(x) / sample_rate, 2) for x in (slow, samples, fast)]} s", flush=True)

    paragraphs = [" ".join(LONG_PARAGRAPHS[:2]), LONG_PARAGRAPHS[2]]
    long_text = "\n\n".join(paragraphs)
    long_samples, long_count = synthesize(long_text, "af_heart", sample_rate, save=args.output_dir / "kokoro-long.wav")
    offset = count = 0
    correlations = []
    for paragraph in paragraphs:
        segment, segment_count = synthesize(paragraph, "af_heart", sample_rate)
        extracted = long_samples[offset:offset + len(segment)]
        assert len(extracted) == len(segment)
        correlation = float(np.corrcoef(energy(segment), energy(extracted))[0, 1])
        assert correlation > 0.9, correlation
        correlations.append(round(correlation, 3))
        offset += len(segment) + round(sample_rate * 0.16)
        count += segment_count
    assert offset - round(sample_rate * 0.16) == len(long_samples)
    assert count == long_count and long_count > len(paragraphs)
    print(f"long text: {len(long_text.split())} words, {long_count} ordered segments, paragraph correlations {correlations}", flush=True)


if __name__ == "__main__":
    main()
