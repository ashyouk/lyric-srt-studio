"""Run a real CC0 singing fixture locally; media itself is never committed."""
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / ".studio-data" / "verification"
VERSE = """Twinkle, twinkle, little star,
How I wonder what you are!
Up above the world so high,
Like a diamond in the sky."""
FULL = VERSE + "\n" + """When the blazing sun is gone,
When he nothing shines upon,
Then you show your little light,
Twinkle, twinkle, all the night.
Then the traveller in the dark,
Thanks you for your tiny spark,
He could not see which way to go,
If you did not twinkle so.
In the dark blue sky you keep,
And often through my curtains peep,
For you never shut your eye,
Till the sun is in the sky.
'Tis your bright and tiny spark,
Lights the traveller in the dark,
Though I know not what you are,
Twinkle, twinkle, little star.""" + "\n" + VERSE + "\n" + """Twinkle, twinkle, little star,
How I wonder what you are!
How I wonder what you are!"""

if __name__ == "__main__":
    full = "--full" in sys.argv
    name = "full" if full else "short"
    audio = DATA / ("twinkle-full.ogg" if full else "twinkle-short.wav")
    text = FULL if full else VERSE
    request = {"audio": str(audio), "method": "asr" if "--asr" in sys.argv else "qwen", "lines": [
        {"id": f"line-{i}", "text": line, "alignmentText": line}
        for i, line in enumerate(text.splitlines())]}
    request_file = DATA / f"{name}-request.json"
    request_file.write_text(json.dumps(request, ensure_ascii=False), encoding="utf-8")
    subprocess.run([sys.executable, str(ROOT / "engine" / "align.py"), str(request_file),
                    str(DATA / f"{name}-alignment.json")], check=True)
