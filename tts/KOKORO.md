# Local Kokoro voice audition

This is a standalone audition. It does not read credentials, modify saved
articles, upload files, or change the existing background worker.

## Installed components

- Python 3.13 environment: `tts/.venv-kokoro`
- Runtime: `kokoro-onnx==0.6.1` (CPU, no PyTorch dependency)
- Model: `tts/models/kokoro-v1.0.onnx`
- Voice pack: `tts/models/voices-v1.0.bin`
- Exact installed Python packages: `tts/requirements-kokoro.lock`
- MP3/WAV output, passage, and generation metadata: `tts/auditions/`

Models, environment, and output are ignored by Git. The MP3 files are local
files; auditioning them does not incur a speech API charge.

## Reproduce

From the repository root, with Python 3.13, uv, and ffmpeg installed:

```sh
UV_CACHE_DIR=/private/tmp/stash-uv-cache uv venv tts/.venv-kokoro --python python3.13
UV_CACHE_DIR=/private/tmp/stash-uv-cache uv pip install --python tts/.venv-kokoro/bin/python -r tts/requirements-kokoro.lock
mkdir -p tts/models
curl --fail --location --retry 3 --output tts/models/kokoro-v1.0.onnx https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.onnx
curl --fail --location --retry 3 --output tts/models/voices-v1.0.bin https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/voices-v1.0.bin
tts/.venv-kokoro/bin/python tts/audition.py
```

The runtime includes an espeak-ng loader for pronunciation. This first audition
uses that runtime's default pronunciation pipeline, rather than the optional
Misaki pipeline. Pronunciation may differ with another pipeline.

The script reads an original fictional passage in all 15 female English voices
by default, at speed 1.0. Use `--voices` to select a subset. The first audition
compares Heart, Bella, Nicole, Sarah, Emma, and Isabella. A second audition in
`tts/auditions/more-female/` compares the remaining nine voices. It adds
the same quarter-second gap between paragraphs for each voice, retains the
uncompressed WAV, and encodes MP3 at 96 kbps. It checks for empty, nonfinite,
or silent audio and stops if generation or conversion fails. The manifest
records asset SHA-256 hashes, package version, passage hash, durations, and
generation times. These checks do not establish pronunciation or listening
quality; compare the samples by ear.

To audition a selected voice on your own UTF-8 text file:

```sh
tts/.venv-kokoro/bin/python tts/audition.py --voices af_heart bf_emma --text /absolute/path/passage.txt
```

Re-running replaces the selected samples, passage, and manifest in
`tts/auditions/`. Use `--output /absolute/path/new-folder` to preserve a previous
audition.

## Sources

- Runtime and asset download instructions: https://github.com/thewh1teagle/kokoro-onnx
- Model and voice descriptions: https://huggingface.co/hexgrad/Kokoro-82M
- Model weights license: Apache 2.0; runtime license: MIT.
