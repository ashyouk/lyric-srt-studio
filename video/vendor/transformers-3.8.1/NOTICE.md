# Browser auto-sync experimental runtime

- Transformers.js 3.8.1: Hugging Face, Apache-2.0; see LICENSE.txt.
  https://github.com/huggingface/transformers.js/tree/3.8.1
- Bundled ONNX Runtime Web 1.22.0-dev.20250409-89f8206ba4: Microsoft, MIT;
  see ONNX-RUNTIME-LICENSE.txt. Shipped JS/WASM are unmodified npm distribution assets.
- Runtime model (downloaded only after consent, not included in this repository):
  onnx-community/whisper-tiny_timestamped, revision
  517244293732ee2d58139af5814231b7e6830a0d, q8 encoder and merged decoder.
  https://huggingface.co/onnx-community/whisper-tiny_timestamped
- Original model: OpenAI Whisper tiny. Original upstream code and weights are MIT:
  https://github.com/openai/whisper/blob/main/LICENSE
  The Hugging Face original model card labels the model Apache-2.0:
  https://huggingface.co/openai/whisper-tiny
  The ONNX conversion card has no separate explicit license field. This is an
  experimental feasibility build, not a commercially cleared release. Confirm
  the converted-weight license/notice chain before commercial distribution.

No models, uploaded songs, lyrics, or generated timing results are distributed
here. Download requests go to Hugging Face; local PCM and canonical lyrics are
transferred only to a same-origin Web Worker. No inference API or paid service.
