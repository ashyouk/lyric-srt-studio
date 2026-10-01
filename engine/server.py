"""Same-origin local Web UI and cancellable PC workers. No hosted inference."""
import argparse
import json
import ipaddress
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
import threading
import time
from urllib.parse import urlparse
import uuid

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
import uvicorn

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / ".studio-data"
MEDIA = DATA / "media"
JOBS = DATA / "jobs"
for directory in [MEDIA, JOBS]:
    directory.mkdir(parents=True, exist_ok=True)
MAX_BYTES = 1024 * 1024 * 1024
app = FastAPI(docs_url=None, redoc_url=None)
media = {}
jobs = {}
worker_lock = threading.Lock()
LAN = False
TOKEN = secrets.token_urlsafe(24)
PORT = 8765


@app.middleware("http")
async def local_boundary(request: Request, call_next):
    origin = request.headers.get("origin")
    host = request.headers.get("host", "")
    hostname = urlparse("http://" + host).hostname
    try:
        if hostname != "localhost":
            ipaddress.ip_address(hostname or "")
    except ValueError:
        return JSONResponse({"detail": "PCのIPアドレスまたはlocalhostで接続してください。"}, 403)
    # No CORS. Reject cross-site requests even when the browser permits a simple POST.
    if origin and urlparse(origin).netloc != host:
        return JSONResponse({"detail": "別サイトからの処理要求は受け付けません。"}, 403)
    if request.headers.get("sec-fetch-site") == "cross-site":
        return JSONResponse({"detail": "同じ処理用PCの画面から操作してください。"}, 403)
    if request.query_params.get("token") == TOKEN:
        response = RedirectResponse("/video/", 303)
        response.set_cookie("studio-access", TOKEN, httponly=True, samesite="strict")
        return response
    loopback = request.client and request.client.host in {"127.0.0.1", "::1"}
    if not loopback and not LAN:
        return JSONResponse({"detail": "ローカル接続専用です。"}, 403)
    if LAN and request.cookies.get("studio-access") != TOKEN and request.headers.get("x-studio-token") != TOKEN:
        return JSONResponse({"detail": "起動時に表示された接続URLを使用してください。"}, 401)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


def probe(path):
    result = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
                            capture_output=True, text=True, encoding="utf-8", timeout=30)
    if result.returncode:
        raise ValueError("素材を読み込めません。MP4・WAV・MP3・M4A・PNG・JPEGを確認してください。")
    info = json.loads(result.stdout)
    streams = info.get("streams", [])
    videos = [s for s in streams if s["codec_type"] == "video" and not s.get("disposition", {}).get("attached_pic")]
    audio = [s for s in streams if s["codec_type"] == "audio"]
    return {"duration": float(info.get("format", {}).get("duration") or 0), "hasVideo": bool(videos),
            "hasAudio": bool(audio), "width": videos[0].get("width") if videos else None,
            "height": videos[0].get("height") if videos else None,
            "audioCodec": audio[0].get("codec_name") if audio else None,
            "videoCodec": videos[0].get("codec_name") if videos else None,
            "startTime": float(info.get("format", {}).get("start_time") or 0)}


@app.get("/api/health")
def health():
    return {"engine": "local-pc", "version": "video-prototype-0.1", "limitSeconds": 300}


@app.post("/api/media")
async def upload(file: UploadFile = File(...)):
    extension = Path(file.filename or "").suffix.lower()
    if extension not in {".mp4", ".wav", ".mp3", ".m4a", ".ogg", ".webm", ".png", ".jpg", ".jpeg"}:
        raise HTTPException(415, "未対応形式です。まずMP4・WAV・MP3・M4A・PNG・JPEGをご利用ください。")
    identifier = uuid.uuid4().hex
    path = MEDIA / f"{identifier}{extension}"
    count = 0
    try:
        with path.open("wb") as stream:
            while chunk := await file.read(1024 * 1024):
                count += len(chunk)
                if count > MAX_BYTES:
                    raise ValueError("初版の素材サイズ上限は1GBです。")
                stream.write(chunk)
        metadata = probe(path)
    except Exception as error:
        path.unlink(missing_ok=True)
        raise HTTPException(400, str(error)) from error
    item = {"id": identifier, "name": Path(file.filename or "素材").name, "size": count,
            "kind": "image" if extension in {".png", ".jpg", ".jpeg"} else "video" if metadata["hasVideo"] else "audio",
            "url": f"/api/media/{identifier}", **metadata}
    media[identifier] = {**item, "path": path}
    return item


@app.get("/api/media/{identifier}")
def media_file(identifier: str):
    if identifier not in media:
        raise HTTPException(404, "素材を選び直してください。")
    return FileResponse(media[identifier]["path"])


def asset(identifier):
    if identifier not in media:
        raise ValueError("素材を選択し直してください。")
    return media[identifier]


def terminate_owned_process(process):
    if process and process.poll() is None:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True,
                           creationflags=subprocess.CREATE_NO_WINDOW)
        else:
            os.killpg(process.pid, signal.SIGTERM)


def run_job(identifier, kind, body):
    job = jobs[identifier]
    with worker_lock:
        if job.get("cancelRequested"):
            return
        process = None
        try:
            source = asset(body.get("mediaId"))
            audio_source = asset(body["audioId"]) if body.get("audioId") else source
            if not audio_source["hasAudio"]:
                raise ValueError("動画に音声がありません。別の音源を選択してください。")
            duration = source["duration"] or audio_source["duration"]
            if not 0 < duration <= 300:
                raise ValueError("この試作は5分以内の素材に対応します。")
            folder = JOBS / identifier
            folder.mkdir()
            request_path = folder / "request.json"
            result_path = folder / ("alignment.json" if kind == "align" else "lyrics.mp4")
            if kind == "align":
                lines = body.get("lines", [])
                if not lines or len(lines) > 1000 or sum(len(l.get("text", "")) for l in lines) > 30000:
                    raise ValueError("歌詞は1〜1000行、3万文字以内で指定してください。")
                payload = {"audio": str(audio_source["path"]), "lines": lines,
                           "method": "asr" if body.get("method") == "asr" else "qwen"}
                command = [sys.executable, str(ROOT / "engine" / "align.py"), str(request_path), str(result_path)]
            else:
                project = body["project"]
                # Never accept filesystem paths, arbitrary codec/filter flags, or page URLs from the UI.
                payload = {"project": project, "source": str(source["path"]), "sourceInfo": {k: v for k, v in source.items() if k != "path"},
                           "audio": str(audio_source["path"]), "duration": duration,
                           "audioSeparate": audio_source["id"] != source["id"],
                           "background": str(asset(body["backgroundId"])["path"]) if body.get("backgroundId") else None,
                           "baseUrl": f"http://127.0.0.1:{PORT}", "output": str(result_path)}
                command = ["node", str(ROOT / "engine" / "export.mjs"), str(request_path)]
            request_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            if job.get("cancelRequested"):
                return
            job.update(status="running", stage="starting", message="処理を開始します。")
            env = {**os.environ, "PYTHONUTF8": "1", "STUDIO_TOKEN": TOKEN if LAN else ""}
            process = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                       text=True, encoding="utf-8", errors="replace", env=env,
                                       start_new_session=os.name != "nt",
                                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            job["process"] = process
            if job.get("cancelRequested"):
                job["status"] = "cancelled"
                terminate_owned_process(process)
            log_path = folder / "worker.log"
            with log_path.open("w", encoding="utf-8") as log:
                for line in process.stdout:
                    log.write(line); log.flush()
                    try:
                        progress = json.loads(line)
                        if isinstance(progress, dict) and "stage" in progress and job["status"] != "cancelled":
                            job.update({k: progress[k] for k in ["stage", "message", "frame", "totalFrames"] if k in progress})
                    except json.JSONDecodeError:
                        pass
            returncode = process.wait()
            if job["status"] == "cancelled":
                return
            if returncode:
                raise ValueError("処理に失敗しました。モデル取得・空きメモリ・FFmpegを確認し、再試行してください。詳細はローカルworker.logに保存しました。")
            job.update(status="complete", stage="complete", message="処理が完了しました。",
                       elapsedSeconds=round(time.monotonic() - job["started"], 2))
            if kind == "align":
                job["result"] = json.loads(result_path.read_text(encoding="utf-8"))
            else:
                metadata = probe(result_path)
                if not metadata["hasAudio"] or not metadata["hasVideo"]:
                    raise ValueError("出力に映像または音声がありません。")
                job["result"] = {"url": f"/api/jobs/{identifier}/download", **metadata}
        except Exception as error:
            if job["status"] != "cancelled":
                job.update(status="failed", message=str(error), stage="failed")
        finally:
            job.pop("process", None)


@app.post("/api/jobs/{kind}")
async def start_job(kind: str, request: Request):
    if kind not in {"align", "export"}:
        raise HTTPException(404, "未対応の処理です。")
    raw = await request.body()
    if len(raw) > 5 * 1024 * 1024:
        raise HTTPException(413, "プロジェクトが大きすぎます。")
    try:
        body = json.loads(raw)
    except ValueError as error:
        raise HTTPException(400, "処理内容を読み込めません。") from error
    if not isinstance(body, dict):
        raise HTTPException(400, "処理内容はプロジェクトとして指定してください。")
    if any(j["status"] in {"queued", "running"} for j in jobs.values()):
        raise HTTPException(409, "実行中の処理が終わるか、キャンセルしてから再実行してください。")
    identifier = uuid.uuid4().hex
    jobs[identifier] = {"id": identifier, "kind": kind, "status": "queued", "stage": "queued", "started": time.monotonic()}
    threading.Thread(target=run_job, args=(identifier, kind, body), daemon=True).start()
    return {"id": identifier}


@app.get("/api/jobs/{identifier}")
def job_status(identifier: str):
    if identifier not in jobs:
        raise HTTPException(404, "処理がありません。")
    return {k: v for k, v in jobs[identifier].items() if k not in {"process", "started"}}


@app.post("/api/jobs/{identifier}/cancel")
def cancel_job(identifier: str):
    if identifier not in jobs:
        raise HTTPException(404, "処理がありません。")
    job = jobs[identifier]
    if job["status"] in {"queued", "running"}:
        job.update(status="cancelled", cancelRequested=True, message="処理をキャンセルしました。", stage="cancelled")
        terminate_owned_process(job.get("process"))
    return {"status": job["status"]}


@app.get("/api/jobs/{identifier}/download")
def download(identifier: str):
    job = jobs.get(identifier)
    if not job or job["kind"] != "export" or job["status"] != "complete":
        raise HTTPException(404, "完成した動画がありません。")
    return FileResponse(JOBS / identifier / "lyrics.mp4", media_type="video/mp4", filename="lyrics.mp4")


app.mount("/video", StaticFiles(directory=ROOT / "video", html=True), name="video")


@app.get("/{filename:path}")
def beta(filename: str):
    # Explicit allowlist keeps source, jobs, models and user media outside the static root.
    filename = filename or "index.html"
    if filename not in {"index.html", "app.js", "styles.css", "srt-core.js"}:
        raise HTTPException(404)
    return FileResponse(ROOT / filename)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--lan", action="store_true", help="Allow trusted LAN devices; creates a per-launch access URL")
    args = parser.parse_args()
    LAN, PORT = args.lan, args.port
    print(f"PC: http://127.0.0.1:{PORT}/video/" + (f"?token={TOKEN}" if LAN else ""), flush=True)
    if LAN:
        print(f"LAN: http://<this-PC-IP>:{PORT}/video/?token={TOKEN} (trusted local network only)", flush=True)
    uvicorn.run(app, host="0.0.0.0" if LAN else "127.0.0.1", port=PORT, access_log=False)
