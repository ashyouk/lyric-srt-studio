"""Exercise Japanese and English model paths on real, locally synthesized SPEECH."""
import json
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
folder = root / '.studio-data' / 'verification'
lyrics = ['星の光が、夜を照らす。', 'あなたと歩いた、この道。',
          'Hello, my shining star.', '星の光が、夜を照らす。']
request = {'audio': str(folder / 'japanese-speech.wav'), 'method': 'qwen',
           'lines': [{'id': str(i), 'text': text, 'alignmentText': text}
                     for i, text in enumerate(lyrics)]}
path = folder / 'japanese-request.json'
path.write_text(json.dumps(request, ensure_ascii=False), encoding='utf-8')
subprocess.run([sys.executable, str(root / 'engine' / 'align.py'), str(path),
                str(folder / 'japanese-alignment.json')], check=True)
