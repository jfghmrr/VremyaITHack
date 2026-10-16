#!/usr/bin/env python3
"""Two public-domain Russian songs: original synthesis, word-aligned karaoke.

Run with numpy + imageio-ffmpeg. No recordings, soundfonts or modern arrangements
are downloaded. The melody, words, phrases and accompaniment share one clock.
Sources and public-domain text editions are documented in LICENSES.md.
"""
import json
import subprocess
from pathlib import Path
import numpy as np
import imageio_ffmpeg

ROOT = Path(__file__).resolve().parents[2] / 'web' / 'static' / 'songs'
SR = 44100
# Each word contains (MIDI, beats). A quarter note is one beat.
SONGS = [
    ('kalinka-words', 'Калинка', 'Русская песня · XIX век', 112, [
        [('Калинка,', [(69,1),(67,1),(64,.5)]), ('калинка,', [(65,.5),(67,1),(64,.5)]), ('калинка', [(65,.5),(67,1),(65,.5)]), ('моя!', [(64,.5),(62,1)])],
        [('В', [(69,.5)]), ('саду', [(69,.5),(67,.75)]), ('ягода', [(65,.25),(64,.5),(65,.5)]), ('малинка,', [(67,1),(64,.5),(65,.5)]), ('малинка', [(67,1),(65,.5),(64,.5)]), ('моя!', [(62,1)])],
    ], [[50,53,57],[45,49,52]]),
    ('berezka-words', 'Во поле берёза стояла', 'Русская народная · сборник 1877 года', 112, [
        [('Во',[(71,.5)]),('поле',[(71,.5),(71,.5)]),('берёза',[(71,.5),(69,.5),(69,.5),(67,.5)]),('стояла,',[(67,.5),(66,1),(64,1)])],
        [('Во',[(71,.5)]),('поле',[(71,.5),(74,.5)]),('кудрявая',[(71,.5),(69,.5),(69,.5),(67,.5)]),('стояла.',[(67,.5),(66,1),(64,1)])],
        [('Люли,',[(66,1.5),(67,.5)]),('люли,',[(69,1),(67,.5)]),('стояла,',[(67,.5),(66,1),(64,1)])],
        [('Люли,',[(66,1.5),(67,.5)]),('люли,',[(69,1),(67,.5)]),('стояла.',[(67,.5),(66,1),(64,1)])],
    ], [[52,55,59],[47,51,54]]),
]

def tone(dest, start, duration, midi, amplitude, pluck=False):
    a = round(start * SR); n = min(round(duration * SR), len(dest) - a)
    t = np.arange(n) / SR
    f = 440 * 2 ** ((midi - 69) / 12)
    env = np.minimum(t / .012, 1) * np.minimum((duration - t) / .04, 1)
    if pluck: env *= np.exp(-t * 3)
    dest[a:a+n] += amplitude * env * (np.sin(2*np.pi*f*t) + .16*np.sin(4*np.pi*f*t) + .06*np.sin(6*np.pi*f*t))

def mp3(path, data):
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-y', '-loglevel', 'error', '-f','f32le','-ar',str(SR),'-ac','1','-i','pipe:0','-codec:a','libmp3lame','-b:a','128k',str(path)], input=data.astype('<f4').tobytes(), check=True)

def main():
    index = json.loads((ROOT / 'index.json').read_text())
    for sid, title, artist, bpm, lines, chords in SONGS:
        beat = 60 / bpm; at = 4 * beat
        events, lyrics, timing, phrases = [], [], [], []
        for line in lines * 2:
            start = at; words = []
            for text, notes in line:
                word_start = at
                for midi, beats in notes:
                    length = beats * beat
                    events.append((at, length - .025, midi))
                    at += length
                words.append(dict(text=text, start_s=round(word_start,4), end_s=round(at,4)))
            lyrics.append(dict(t=round(start,4),text=' '.join(w['text'] for w in words)))
            timing.append(dict(line=len(lyrics)-1,words=words))
            phrases.append(dict(start_s=round(start,4),end_s=round(at-.025,4)))
            at += beat  # one beat to breathe, explicitly excluded from scoring
        duration = round(at + beat,2)
        f0 = [None] * round(duration * 100)
        backing = np.zeros(round(duration*SR)); melody = np.zeros_like(backing)
        for start, length, midi in events:
            for i in range(round(start*100),round((start+length)*100)): f0[i] = float(midi)
            tone(melody,start,length,midi,.24)
        # An original light plucked/bass arrangement, with a quiet guide to enter on time.
        for step in range(int(duration/beat)):
            chord = chords[(step//4)%len(chords)]
            tone(backing,step*beat,beat*.9,chord[0]-12,.12,True)
            for i, note in enumerate(chord): tone(backing,(step+.12*i)*beat,beat*.65,note,.065,True)
        folder = ROOT / sid; folder.mkdir(exist_ok=True)
        mp3(folder/'backing.mp3',backing + melody*.12)
        mp3(folder/'guide.mp3',backing*.6 + melody)
        ref=dict(id=sid,title=title,artist=artist,hop_ms=10,duration_s=duration,f0_midi=f0,phrases=phrases,lyrics=lyrics,backing='backing.mp3')
        (folder/'reference.json').write_text(json.dumps(ref,ensure_ascii=False,separators=(',',':'))+'\n')
        (folder/'lyrics.words.json').write_text(json.dumps(dict(v=1,lines=timing),ensure_ascii=False,indent=2)+'\n')
        info=dict(id=sid,title=title,artist=artist,duration_s=duration,tag='Слова · инструментальная версия',category='Русские',preview='guide.mp3',wordTiming='lyrics.words.json',contour=f0[::max(1,len(f0)//160)])
        index = [s for s in index if s['id'] != sid] + [info]
        print(f'{title}: {duration}s, {len(timing)} lines, {sum(len(l["words"]) for l in timing)} words')
    # Preserve other entries byte-for-byte in spirit (compact one entry per line).
    (ROOT/'index.json').write_text('[\n  '+',\n  '.join(json.dumps(s,ensure_ascii=False,separators=(',',':')) for s in index)+'\n]\n')

if __name__ == '__main__': main()
