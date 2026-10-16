#!/usr/bin/env python3
"""Собирает каталог из свободных мелодий (catalog.py): эталон, ориентир и минусовку.

Для MIDI-источника мелодией считается одноголосная дорожка с самым высоким средним
звуком; если такой нет, берётся верхний голос (самая высокая нота в каждый момент).
Остальные голоса становятся минусовкой. Для мелодий, записанных вручную, аккомпанемент
строится по гармонии тактов: бас и разложенный аккорд.

Синтез простой и свой: никакие записи не скачиваются. Существующие «Ода к радости» и
«Маленькая звезда» не трогаются — от их эталонов зависят разосланные ссылки-вызовы.

Запуск: tools/songs/.venv/bin/python tools/songs/import_songs.py
"""
import html, json, math, struct, subprocess, wave
from array import array
from pathlib import Path

import imageio_ffmpeg
import mido

from catalog import MANUAL, SONGS

HERE = Path(__file__).resolve().parent
OUT = HERE.parents[1] / "web" / "static" / "songs"
SR = 22050
GAP = 0.055  # пауза перед повторной атакой: начала нот различимы для ритма
LEAD = 1.2   # секунд до первой ноты мелодии

CHORDS = {"C": (48, [0, 4, 7]), "Dm": (50, [0, 3, 7]), "E": (52, [0, 4, 7]), "F": (53, [0, 4, 7]),
          "G": (55, [0, 4, 7]), "Am": (45, [0, 3, 7]), "Bb": (46, [0, 4, 7]), "D": (50, [0, 4, 7]),
          "A": (45, [0, 4, 7]), "Em": (52, [0, 3, 7]), "Gm": (55, [0, 3, 7])}


def load_midi(path):
    """Ноты всех дорожек в секундах: (start, end, pitch, track)."""
    mid = mido.MidiFile(path)
    tempo_map = [(0, 500000)]
    for tr in mid.tracks:
        t = 0
        for msg in tr:
            t += msg.time
            if msg.type == "set_tempo":
                tempo_map.append((t, msg.tempo))
    tempo_map.sort()
    sig = next((m for tr in mid.tracks for m in tr if m.type == "time_signature"), None)
    beats_per_bar = sig.numerator * 4 / sig.denominator if sig else 4

    def seconds(tick):
        s, last_tick, tempo = 0.0, 0, tempo_map[0][1]
        for at, tp in tempo_map:
            if at > tick:
                break
            s += (at - last_tick) * tempo / 1e6 / mid.ticks_per_beat
            last_tick, tempo = at, tp
        return s + (tick - last_tick) * tempo / 1e6 / mid.ticks_per_beat

    notes = []
    for ti, tr in enumerate(mid.tracks):
        t, on = 0, {}
        for msg in tr:
            t += msg.time
            if msg.type == "note_on" and msg.velocity > 0 and msg.channel != 9:
                on.setdefault((msg.channel, msg.note), []).append(t)
            elif msg.type in ("note_off", "note_on") and msg.channel != 9 and on.get((msg.channel, msg.note)):
                start = on[(msg.channel, msg.note)].pop(0)
                notes.append((seconds(start), seconds(t), msg.note, ti))
    bar_s = seconds(int(beats_per_bar * mid.ticks_per_beat))
    return sorted(notes), bar_s


def pick_melody(notes, spec):
    """Мелодия из заданных дорожек: в каждый момент атаки — верхняя нота, без наложений."""
    chosen = {ti: shift for ti, shift in spec}
    picked = [(a, b, p + chosen[t], t) for a, b, p, t in notes if t in chosen]
    by_start = {}
    for n in picked:
        by_start.setdefault(round(n[0], 2), []).append(n)
    melody = [max(group, key=lambda n: n[2]) for _, group in sorted(by_start.items())]
    for i in range(len(melody) - 1):
        a, b = melody[i], melody[i + 1]
        if a[1] > b[0]:
            melody[i] = (a[0], b[0], a[2], a[3])
    used = {(round(n[0], 2), n[3]) for n in melody}
    rest = [n for n in notes if n[3] not in chosen or (round(n[0], 2), n[3]) not in used]
    rest = [n for n in rest if not (n[3] in chosen and any(abs(n[0] - m[0]) < 0.01 and n[2] + chosen[n[3]] == m[2] for m in melody))]
    return melody, rest


def split_melody(notes):
    tracks = {}
    for n in notes:
        tracks.setdefault(n[3], []).append(n)

    def monophonic(ns):
        return all(b[0] >= a[1] - 0.02 for a, b in zip(ns, ns[1:]))

    candidates = [(sum(n[2] for n in ns) / len(ns), ti) for ti, ns in tracks.items() if len(ns) >= 8 and monophonic(sorted(ns))]
    if candidates and len(tracks) > 1:
        ti = max(candidates)[1]
        return sorted(tracks[ti]), [n for n in notes if n[3] != ti]
    # Верхний голос: в каждый момент атаки — самая высокая нота.
    melody, rest = [], []
    by_start = {}
    for n in notes:
        by_start.setdefault(round(n[0], 3), []).append(n)
    for start in sorted(by_start):
        group = sorted(by_start[start], key=lambda n: -n[2])
        melody.append(group[0])
        rest += group[1:]
    for i in range(len(melody) - 1):
        a, b = melody[i], melody[i + 1]
        if a[1] > b[0]:
            melody[i] = (a[0], b[0], a[2], a[3])
    return melody, rest


def manual(spec):
    beat = 60 / spec["tempo"]
    pickup = spec.get("pickup", 0) * beat
    bar = 4 * beat
    melody, backing = [], []
    for r in range(spec.get("repeat", 1)):
        t = r * (len(spec["chords"]) * bar)
        for pitch, dur in spec["melody"]:
            if pitch is not None:
                melody.append((t, t + dur * beat, pitch, 0))
            t += dur * beat
        for bi, name in enumerate(spec["chords"]):
            root, shape = CHORDS[name]
            b0 = r * len(spec["chords"]) * bar + pickup + bi * bar
            backing.append((b0, b0 + 2 * beat, root - 12, 1))
            backing.append((b0 + 2 * beat, b0 + 4 * beat, root - 12 + 7, 1))
            for k in range(8):
                p = root + shape[[0, 1, 2, 1][k % 4]] + 12
                backing.append((b0 + k * beat / 2, b0 + (k + 1) * beat / 2, p, 2))
    return melody, backing, bar


def cut(melody, backing, bar_s, max_s):
    """Фрагмент до max_s секунд, обрезанный на границе такта после окончания ноты."""
    first = melody[0][0]
    limit = first + max_s
    ends = [n[1] for n in melody if n[1] <= limit + 0.05]
    end = max(ends) if ends else limit
    keep = [n for n in melody if n[1] <= end + 0.01]
    stop = keep[-1][1]
    acc = [(a, min(b, stop + 0.6), p, t) for a, b, p, t in backing if a < stop - 0.02]
    return keep, acc


def octave_shift(melody):
    mean = sum(n[2] for n in melody) / len(melody)
    shift = 0
    while mean + shift > 74:
        shift -= 12
    while mean + shift < 58:
        shift += 12
    return shift


def phrases_of(melody, bar_s):
    phrases, start = [], melody[0][0]
    for a, b in zip(melody, melody[1:]):
        if b[0] - a[1] >= 0.3 or (b[0] - start >= 4 * bar_s - 0.05 and b[0] - start > 6):
            phrases.append({"start_s": round(start, 3), "end_s": round(a[1] - GAP, 3)})
            start = b[0]
    phrases.append({"start_s": round(start, 3), "end_s": round(melody[-1][1] - GAP, 3)})
    return phrases


def render(notes, total, voice):
    buf = array("f", [0.0]) * int(total * SR)
    for start, end, pitch, _ in notes:
        f = 440 * 2 ** ((pitch - 69) / 12)
        dur = max(0.05, end - start - (GAP if voice else 0.02))
        n0 = int(start * SR)
        for j in range(int(dur * SR)):
            i = n0 + j
            if i >= len(buf):
                break
            t = j / SR
            if voice:
                env = min(1, t / 0.012) * min(1, (dur - t) / 0.07)
                buf[i] += 0.23 * env * (math.sin(2 * math.pi * f * t) + 0.2 * math.sin(4 * math.pi * f * t)) / 1.2
            else:
                # Мягкий щипковый тембр с затуханием: аккомпанемент не маскирует голос.
                env = min(1, t / 0.008) * math.exp(-2.2 * t) * min(1, (dur - t) / 0.05)
                buf[i] += 0.09 * env * (math.sin(2 * math.pi * f * t) + 0.35 * math.sin(4 * math.pi * f * t) + 0.12 * math.sin(6 * math.pi * f * t))
    peak = max(1e-6, max(abs(x) for x in buf))
    limit = 0.85 if voice else 0.6
    return [x * min(1, limit / peak) for x in buf]


def save_wav(path, samples):
    with wave.open(str(path), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(SR)
        f.writeframes(b"".join(struct.pack("<h", int(max(-1, min(1, x)) * 32767)) for x in samples))


def build(song):
    if song["id"] in MANUAL:
        melody, backing, bar_s = manual(MANUAL[song["id"]])
    else:
        notes, bar_s = load_midi(HERE / "cache" / f"{song['id']}.mid")
        skip = song.get("skip_s", 0)
        notes = [(a - skip, b - skip, p, t) for a, b, p, t in notes if a >= skip - 0.01]
        melody, backing = pick_melody(notes, song["melody"]) if "melody" in song else split_melody(notes)
    melody, backing = cut(melody, backing, bar_s, song["max_s"])
    shift = octave_shift(melody)
    offset = LEAD - melody[0][0]
    melody = [(a + offset, b + offset, p + shift, t) for a, b, p, t in melody]
    backing = [(a + offset, b + offset, p + shift, t) for a, b, p, t in backing if a + offset >= 0]
    duration = round(min(60.0, melody[-1][1] + 1.0), 2)
    f0 = [None] * int(round(duration * 100))
    for a, b, p, _ in melody:
        for k in range(round(a * 100), min(len(f0), round((b - GAP) * 100))):
            f0[k] = float(p)
    phrases = phrases_of(melody, bar_s)
    folder = OUT / song["id"]
    folder.mkdir(parents=True, exist_ok=True)
    save_wav(folder / "guide.wav", render(melody, duration, True))
    save_wav(folder / "backing.wav", render(backing, duration, False))
    for name, rate in (("backing", "96k"), ("guide", "64k")):
        subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-i", str(folder / f"{name}.wav"),
                        "-codec:a", "libmp3lame", "-b:a", rate, str(folder / f"{name}.mp3")], check=True)
        (folder / f"{name}.wav").unlink()
    lyrics = [{"t": 0, "text": "Приготовься. Пой мелодию на «ла»."}]
    lyrics += [{"t": p["start_s"], "text": "Ла · ла · ла — пой в удобной тональности"} for p in phrases]
    lyrics.append({"t": phrases[-1]["end_s"], "text": "Отлично. Дай последней ноте прозвучать."})
    reference = {"id": song["id"], "title": song["title"], "artist": song["artist"], "hop_ms": 10, "duration_s": duration,
                 "f0_midi": f0, "phrases": phrases, "lyrics": lyrics, "backing": "backing.mp3"}
    (folder / "reference.json").write_text(json.dumps(reference, ensure_ascii=False, separators=(",", ":")) + "\n")
    voiced = [p for p in f0 if p is not None]
    print(f"{song['id']:<15} {duration:5.1f} с  нот {len(melody):3d}  фраз {len(phrases)}  диапазон {min(voiced):.0f}–{max(voiced):.0f}  аккомп. {len(backing)}")
    return {"id": song["id"], "title": song["title"], "artist": song["artist"], "duration_s": duration,
            "tag": song["tag"], "category": song["category"], "preview": "guide.mp3"}


def contour(f0, points=160):
    """Упрощённый контур мелодии для мини-графика в каталоге."""
    out = []
    for i in range(points):
        chunk = [v for v in f0[i * len(f0) // points:(i + 1) * len(f0) // points] if v is not None]
        out.append(round(sum(chunk) / len(chunk), 1) if chunk else None)
    return out


def main():
    index_path = OUT / "index.json"
    managed = {s["id"] for s in SONGS}
    existing = [s for s in json.loads(index_path.read_text()) if s["id"] not in managed]
    for s in existing:
        s.setdefault("category", "Классика" if s["id"] == "ode" else "Детские")
    built = [build(song) for song in SONGS]
    index_path.write_text(json.dumps(existing + built, ensure_ascii=False, indent=2) + "\n")
    for entry in existing + built:
        ref = json.loads((OUT / entry["id"] / "reference.json").read_text())
        entry["contour"] = contour(ref["f0_midi"])
    # По записи на строку: файл читается глазами, а контуры не раздувают его.
    lines = ",\n".join("  " + json.dumps(e, ensure_ascii=False, separators=(",", ":")) for e in existing + built)
    index_path.write_text("[\n" + lines + "\n]\n")
    write_music_page(existing + built)
    print(f"Каталог: {len(existing) + len(built)} песен")


def write_music_page(index):
    """Данные для страницы «Музыка и лицензии»: происхождение каждой песни."""
    sources = json.loads((HERE / "sources.json").read_text())
    target = HERE.parents[1] / "web" / "src" / "lib" / "legal" / "music.json"
    preserved = {m["id"]: m for m in json.loads(target.read_text())} if target.exists() else {}
    rows = []
    for s in index:
        if s.get("wordTiming") and s["id"] in preserved:
            rows.append(preserved[s["id"]])
            continue
        src = sources.get(s["id"])
        if src:
            origin = f"Исходная запись MIDI: {html.unescape(src['author'])}, Wikimedia Commons, лицензия {src['license']}."
            link = src["page"]
        elif s["id"] in ("ode", "star"):
            origin = "Ноты набраны вручную, синтез и аранжировка созданы в проекте (MIT)."
            link = None
        else:
            origin = "Общеизвестная мелодия записана нотами вручную, аккомпанемент построен по гармонии в проекте (MIT)."
            link = None
        rows.append({"id": s["id"], "title": s["title"], "artist": s["artist"], "origin": origin, "link": link})
    target = HERE.parents[1] / "web" / "src" / "lib" / "legal" / "music.json"
    target.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
