"""Measure output media timing, not human lyric accuracy; generated evidence stays local."""
import json
import math
from pathlib import Path
import subprocess
import sys
import numpy as np
from scipy.signal import correlate, correlation_lags, resample_poly
import soundfile as sf

output = Path(sys.argv[1])
reference = Path(sys.argv[2])
metadata = json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(output)]))
videos = [s for s in metadata['streams'] if s['codec_type']=='video']
audios = [s for s in metadata['streams'] if s['codec_type']=='audio']
assert len(videos)==len(audios)==1, 'exactly one video and one audio stream'
assert (videos[0]['width'],videos[0]['height'])==(1920,1080)
wav = output.with_suffix('.decoded.wav')
subprocess.run(['ffmpeg','-loglevel','error','-y','-i',str(output),'-vn','-ar','16000','-ac','1',str(wav)],check=True)
x,sr=sf.read(reference,dtype='float32')
if x.ndim > 1:
    x=x.mean(axis=1)
if sr != 16000:
    divisor=math.gcd(sr,16000)
    x=resample_poly(x,16000//divisor,sr//divisor)
    sr=16000
y,_=sf.read(wav,dtype='float32')
duration=min(len(x),len(y))/sr
checks=[]
for seconds in [1, duration/2, max(1,duration-5)]:
    start=int(seconds*sr)
    a=x[start:start+sr*2];b=y[start:start+sr*2]
    size=min(len(a),len(b));a=a[:size];b=b[:size]
    c=correlate(b,a,method='fft');lags=correlation_lags(size,size)
    lag=int(lags[int(np.argmax(c))])/sr
    ratio=float(np.sqrt(np.mean(b*b))/max(1e-8,np.sqrt(np.mean(a*a))))
    assert abs(lag)<.04, 'audio shifts less than one 30fps frame'
    assert .9<ratio<1.1, 'audio is not doubled or attenuated'
    checks.append({'at':round(seconds,3),'lagSeconds':lag,'rmsRatio':round(ratio,5)})
report={'file':output.name,'duration':float(metadata['format']['duration']),
        'videoDuration':float(videos[0]['duration']),'audioDuration':float(audios[0]['duration']),
        'videoCodec':videos[0]['codec_name'],'audioCodec':audios[0]['codec_name'],'audioChecks':checks}
output.with_suffix('.verification.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report))
