#!/usr/bin/env python3
"""Original synthesized backing and guide; no downloaded recordings or arrangements.
Requires imageio-ffmpeg for MP3 encoding; standard library for synthesis.
"""
import json, math, wave, struct, subprocess
from pathlib import Path
import imageio_ffmpeg
ROOT = Path(__file__).resolve().parents[2] / 'web' / 'static' / 'songs'
SR = 22050
SONGS = [
 ('ode', 'Ода к радости', 'Людвиг ван Бетховен · 1824', 'Начни здесь', [
 [64,64,65,67,67,65,64,62,60,60,62,64,64,62,62],
 [64,64,65,67,67,65,64,62,60,60,62,64,62,60,60]]),
 ('star', 'Маленькая звезда', 'Французская мелодия · XVIII век', 'Попробуй скачки', [
 [60,60,67,67,69,69,67,65,65,64,64,62,62,60],
 [67,67,65,65,64,64,62,67,67,65,65,64,64,62]])]

def save_wav(path, samples):
 with wave.open(str(path),'wb') as f:
  f.setnchannels(1); f.setsampwidth(2); f.setframerate(SR)
  f.writeframes(b''.join(struct.pack('<h',int(max(-1,min(1,x))*32767)) for x in samples))

def tone(samples,start,duration,midi,amp=.1):
 freq=440*2**((midi-69)/12)
 for j in range(int(duration*SR)):
  i=int(start*SR)+j
  if i>=len(samples):break
  t=j/SR; env=min(1,t/.012)*min(1,(duration-t)/.07)
  samples[i]+=amp*env*(math.sin(2*math.pi*freq*t)+.2*math.sin(4*math.pi*freq*t))/1.2

manifest=[]
for sid,title,artist,tag,phrases_notes in SONGS:
 folder=ROOT/sid;folder.mkdir(parents=True,exist_ok=True)
 duration=20.; f0=[None]*2000; backing=[0.] * int(duration*SR); guide=backing.copy(); phrases=[]
 start=1.
 for pi,notes in enumerate(phrases_notes):
  phrase_start=start
  for ni,note in enumerate(notes):
   length=1.0 if ni==len(notes)-1 else .5
   sounding=length-.055
   for k in range(round(start*100),round((start+sounding)*100)):f0[k]=float(note)
   tone(guide,start,sounding,note,.23)
   start+=length
  phrases.append({'start_s':phrase_start,'end_s':start-.055}); start+=.7
 # A simple original broken-chord accompaniment; deliberately no guide melody in backing.
 for beat in range(38):
  chord=[48,52,55] if (beat//8)%2==0 else [43,47,50]
  tone(backing,beat*.5,.43,chord[beat%3],.13)
  tone(backing,beat*.5,.09,84,.016)
 save_wav(folder/'backing.wav',backing)
 save_wav(folder/'guide.wav',guide)
 subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(),'-y','-loglevel','error','-i',str(folder/'backing.wav'),'-codec:a','libmp3lame','-b:a','96k',str(folder/'backing.mp3')],check=True)
 (folder/'backing.wav').unlink()
 reference={'id':sid,'title':title,'artist':artist,'hop_ms':10,'duration_s':duration,'f0_midi':f0,'phrases':phrases,'lyrics':[{'t':0,'text':'Приготовься. Пой мелодию на «ла».'}]+[{'t':p['start_s'],'text':'Ла · ла · ла — пой в удобной тональности'} for p in phrases]+[{'t':phrases[-1]['end_s'],'text':'Отлично. Дай последней ноте прозвучать.'}],'backing':'backing.mp3'}
 (folder/'reference.json').write_text(json.dumps(reference,ensure_ascii=False,separators=(',',':'))+'\n')
 manifest.append({'id':sid,'title':title,'artist':artist,'duration_s':duration,'tag':tag,'preview':'guide.wav'})
# index.json собирает import_songs.py: здесь он не перезаписывается, чтобы не потерять каталог.
print('Пересозданы файлы «Оды к радости» и «Маленькой звезды»; каталог index.json не изменён.')
