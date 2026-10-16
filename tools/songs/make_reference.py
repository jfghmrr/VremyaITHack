#!/usr/bin/env python3
"""Extract a reference from an isolated, licensed vocal. Audio is processed locally."""
import argparse,json
from pathlib import Path
import librosa
import numpy as np
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('vocal',type=Path);p.add_argument('--out',type=Path,required=True)
p.add_argument('--id',required=True);p.add_argument('--title',required=True);p.add_argument('--artist',default='')
p.add_argument('--backing',default='backing.mp3');p.add_argument('--lyrics',type=Path,help='JSON array of {t,text}')
a=p.parse_args()
y,sr=librosa.load(a.vocal,sr=22000,mono=True)
f0,voiced,_=librosa.pyin(y,fmin=65,fmax=1100,sr=sr,frame_length=2048,hop_length=220,center=True)
values=[float(librosa.hz_to_midi(f)) if v and np.isfinite(f) else None for f,v in zip(f0,voiced)]
values=values[:int(np.ceil(len(y)/sr/.01))]
indices=[i for i,v in enumerate(values) if v is not None];phrases=[]
if indices:
 start=prev=indices[0]
 for i in indices[1:]:
  if i-prev>31:phrases.append({'start_s':start*.01,'end_s':(prev+1)*.01});start=i
  prev=i
 phrases.append({'start_s':start*.01,'end_s':(prev+1)*.01})
result={'id':a.id,'title':a.title,'artist':a.artist,'hop_ms':10,'duration_s':len(y)/sr,'f0_midi':values,'phrases':phrases,'lyrics':json.loads(a.lyrics.read_text()) if a.lyrics else [],'backing':a.backing}
a.out.parent.mkdir(parents=True,exist_ok=True);a.out.write_text(json.dumps(result,ensure_ascii=False,separators=(',',':'))+'\n')
print(f'{a.out}: {len(phrases)} phrases, {len(values)} frames')
