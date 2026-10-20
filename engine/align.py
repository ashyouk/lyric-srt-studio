"""Local acoustic forced alignment, with independent ASR evidence, never lyric rewriting."""
import argparse
import difflib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import unicodedata

MODEL = "Qwen/Qwen3-ForcedAligner-0.6B-hf"


def select_asr_model(request):
    value = request.get("asrModel") or os.environ.get("LYRIC_ASR_MODEL", "small")
    if not isinstance(value, str) or value not in {"small", "large-v3-turbo"}:
        raise ValueError("音声認識モデルはsmallまたはlarge-v3-turboを選択してください。")
    return value


def normalized(text):
    # Matching only: this unambiguous old glyph does not change display text
    # or guess kana/kanji/proper-name pronunciations.
    value = unicodedata.normalize("NFKC", str(text)).lower().replace("聲", "声")
    return "".join(c for c in value
                   if c.isalnum())


def aggregate(lines, words, recognized, duration):
    """Map timestamped token characters to canonical rows; retain unmatched rows as review."""
    ranges = []
    combined = ""
    for line in lines:
        value = normalized(line.get("alignmentText") or line["text"])
        ranges.append((len(combined), len(combined) + len(value)))
        combined += value
    timed_chars = []
    word_text = ""
    for word in words:
        value = normalized(word["text"])
        word_text += value
        timed_chars.extend([(word["start_time"], word["end_time"])] * len(value))
    matches = {}
    for block in difflib.SequenceMatcher(None, combined, word_text, autojunk=False).get_matching_blocks():
        for offset in range(block.size):
            matches[block.a + offset] = timed_chars[block.b + offset]
    heard = normalized(recognized)
    heard_matches = set()
    for block in difflib.SequenceMatcher(None, combined, heard, autojunk=False).get_matching_blocks():
        heard_matches.update(range(block.a, block.a + block.size))
    results = []
    previous_end = 0
    for line, (left, right) in zip(lines, ranges):
        spans = [matches[i] for i in range(left, right) if i in matches]
        agreement = sum(i in heard_matches for i in range(left, right)) / max(1, right - left)
        start = round(min((s[0] for s in spans), default=-1), 3)
        end = round(max((s[1] for s in spans), default=-1), 3)
        reasons = ["歌唱への自動推定です。再生して確認してください。"]
        valid = bool(spans) and 0 <= start < end <= duration + .15
        start_matched = left < right and left in matches
        end_matched = left < right and right - 1 in matches
        if not valid:
            reasons.append("有効な歌声区間を確定できませんでした。")
        if spans and not (start_matched and end_matched):
            reasons.append("行の先頭または末尾に音響時刻がない部分候補です。境界を再生して確認してください。")
            # A sub-half-second fragment is not evidence for the whole row.
            # Keep longer existing candidates for review; never pad or shift them.
            if end - start < .5:
                reasons.append("0.5秒未満の短い部分候補を行全体の時刻に採用していません。")
                valid = False
        if agreement < .45:
            reasons.append("独立した音声認識との一致が少ないため、未歌唱・表記・繰り返しを確認してください。")
            valid = False
        if valid and start < previous_end - .08:
            reasons.append("前の行と重なる推定です。重唱または境界を確認してください。")
        if valid and end - start > 16:
            reasons.append("長い区間です。伸ばす歌声か間奏への誤配置かを確認してください。")
        if len(spans) < right - left:
            reasons.append("照合用文字の一部に時刻がありません。")
        results.append({
            "id": line["id"], "start": start if valid else None, "end": end if valid else None,
            "candidateStart": start if start >= 0 else None,
            "candidateEnd": end if end >= 0 else None,
            "review": True, "reasons": reasons,
            "evidence": {"asrCharacterAgreement": round(agreement, 4),
                         "matchedCharacters": len(spans), "inputCharacters": right - left,
                         "startCharacterMatched": start_matched, "endCharacterMatched": end_matched},
        })
        if valid:
            previous_end = end
    return results


def event(stage, **fields):
    print(json.dumps({"stage": stage, **fields}, ensure_ascii=False), flush=True)


def acoustic_boundaries(audio, sr, start, end):
    """Trim actual low-energy edges, not musical rests inferred from lyric length.

    This is useful for quiet/a-cappella material. With accompaniment the threshold
    may not find silence; it leaves the acoustic estimate in place for review.
    """
    import numpy as np
    left, right = round(start * sr), min(len(audio), round(end * sr))
    step = max(1, round(sr * .01))
    samples = audio[left:right]
    blocks = len(samples) // step
    if blocks < 2:
        return start, end
    rms = np.sqrt(np.mean(samples[:blocks * step].reshape(blocks, step) ** 2, axis=1))
    threshold = max(.002, float(np.quantile(rms, .85)) * .08)
    voiced = np.flatnonzero(rms > threshold)
    if not len(voiced):
        return None, None
    return round(start + max(0, int(voiced[0]) - 3) * .01, 3), round(min(end, start + (int(voiced[-1]) + 4) * .01), 3)


def run(request_path, result_path):
    # Trust the OS certificate store; never disable TLS verification for model downloads.
    import truststore
    truststore.inject_into_ssl()
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    started = time.monotonic()
    request = json.loads(Path(request_path).read_text(encoding="utf-8"))
    asr_model = select_asr_model(request)
    lines = request["lines"]
    if not lines or len(lines) > 1000:
        raise ValueError("歌詞は1〜1000行で指定してください。")
    source = Path(request["audio"])
    if not source.is_file():
        raise ValueError("音源を選び直してください。")
    wav = Path(result_path).with_suffix(".wav")
    event("extract", message="音声を16kHzモノラルへ変換中")
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(source),
                    "-vn", "-af", "aresample=async=1:first_pts=0", "-ac", "1", "-ar", "16000", str(wav)], check=True)
    import soundfile as sf
    audio, sr = sf.read(wav, dtype="float32")
    duration = len(audio) / sr
    if duration > 300:
        raise ValueError("この試作の自動同期は5分以内です。長い曲は手動編集をご利用ください。")
    event("load-recognizer", message=f"音声認識モデルを読込中：{asr_model}（初回はダウンロード）")
    from faster_whisper import WhisperModel
    asr = WhisperModel(asr_model, device="cpu", compute_type="int8",
                       cpu_threads=max(1, min(4, os.cpu_count() or 1)))
    event("recognize", message="音声認識で歌われた内容を確認中（表示歌詞には使いません）")
    segments, _ = asr.transcribe(audio, beam_size=5, word_timestamps=True, vad_filter=False,
                                condition_on_previous_text=False)
    segments = list(segments)
    recognized = " ".join(segment.text for segment in segments)
    asr_words = [{"text": w.word, "start_time": w.start, "end_time": w.end}
                 for segment in segments for w in segment.words]
    del asr
    import gc
    gc.collect()
    if request.get("method", "qwen") == "asr":
        # Monotonic text matching uses real acoustic word times, not duration/character division.
        result = {"engine": f"faster-whisper-{asr_model}-word-alignment", "duration": duration,
                  "elapsedSeconds": round(time.monotonic() - started, 2),
                  "lines": aggregate(lines, asr_words, recognized, duration),
                  "diagnostics": {"recognizedForMatchingOnly": recognized, "wordTimings": asr_words,
                                  "asrModel": asr_model}}
        Path(result_path).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        event("complete", message="音声認識の音響時刻から歌詞行の候補を作成しました。再生して確認してください。")
        return
    event("load-aligner", message="強制アラインメントモデルを読込中（初回はモデルをダウンロード）")
    import torch
    from transformers import AutoProcessor, AutoModelForTokenClassification
    torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
    model_source = MODEL
    processor = AutoProcessor.from_pretrained(model_source)
    model = AutoModelForTokenClassification.from_pretrained(model_source, dtype=torch.float32,
                                                           attn_implementation="sdpa")
    text = "\n".join(line.get("alignmentText") or line["text"] for line in lines)
    language = "Japanese" if re.search(r"[\u3040-\u30ff\u3400-\u9fff]", text) else "English"
    # Whole-song forced alignment can squeeze rows into instrumental gaps or shift
    # repeated verses. First locate acoustic word anchors, then refine each row in
    # that real audio window. Missing ASR evidence remains unplaced, never interpolated.
    anchors = aggregate(lines, asr_words, recognized, duration)
    words = []
    aligned_lines = []
    for index, (line, anchor) in enumerate(zip(lines, anchors)):
        event("align", message=f"入力歌詞と歌声の位置を照合中：{index + 1}/{len(lines)}行")
        if anchor["start"] is None:
            aligned_lines.append(anchor)
            continue
        left = max(0, anchor["start"] - .65)
        right = min(duration, anchor["end"] + .65)
        crop = audio[round(left * sr):round(right * sr)]
        inputs, word_lists = processor.prepare_forced_aligner_inputs(
            audio=crop, transcript=line.get("alignmentText") or line["text"], language=language)
        with torch.inference_mode():
            outputs = model(**inputs)
        row_words = processor.decode_forced_alignment(logits=outputs.logits, input_ids=inputs["input_ids"],
            word_lists=word_lists, timestamp_token_id=model.config.timestamp_token_id)[0]
        row_words = [{**word, "start_time": round(word["start_time"] + left, 3),
                      "end_time": round(word["end_time"] + left, 3)} for word in row_words]
        heard_in_window = " ".join(w["text"] for w in asr_words if w["end_time"] > left and w["start_time"] < right)
        estimate = aggregate([line], row_words, heard_in_window, duration)[0]
        if estimate["start"] is not None:
            # A forced aligner must timestamp supplied words even when a crop includes
            # the preceding note. Reject large disagreements with independent anchors.
            if abs(estimate["start"] - anchor["start"]) > .35:
                estimate["start"] = anchor["start"]
                estimate["reasons"].append("開始境界の推定に差があるため音声認識の音響時刻を使用しました。")
            if abs(estimate["end"] - anchor["end"]) > .75:
                estimate["end"] = anchor["end"]
                estimate["reasons"].append("終了境界の推定に差があります。伸ばす音を確認してください。")
            estimate["start"], estimate["end"] = acoustic_boundaries(audio, sr, estimate["start"], estimate["end"])
        aligned_lines.append(estimate)
        words.extend(row_words)
    for previous, current in zip(aligned_lines, aligned_lines[1:]):
        if previous["end"] is not None and current["start"] is not None and current["start"] < previous["end"]:
            current["reasons"].append("前の行と重なっています。重唱または境界を確認してください。")
    result = {"engine": MODEL, "duration": duration, "elapsedSeconds": round(time.monotonic() - started, 2),
              "lines": aligned_lines,
              "diagnostics": {"recognizedForMatchingOnly": recognized, "wordTimings": words,
                              "language": language, "asrAnchors": anchors,
                              "asrModel": asr_model}}
    Path(result_path).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    event("complete", message="同期候補を作成しました。要確認の行を再生してください。")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("request")
    parser.add_argument("result")
    args = parser.parse_args()
    run(args.request, args.result)
