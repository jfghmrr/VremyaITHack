import sys, mido
from import_songs import load_midi
for sid in sys.argv[1:]:
    mid = mido.MidiFile(f"cache/{sid}.mid")
    notes, bar = load_midi(f"cache/{sid}.mid")
    print(f"== {sid}: type {mid.type}, tracks {len(mid.tracks)}, bar {bar:.2f}s")
    for ti, tr in enumerate(mid.tracks):
        ns = sorted(n for n in notes if n[3] == ti)
        name = next((m.name for m in tr if m.type == "track_name"), "")
        chans = sorted({m.channel for m in tr if hasattr(m, "channel")})
        if not ns: 
            print(f"  t{ti} '{name}' ch{chans}: no notes"); continue
        mono = all(b[0] >= a[1] - 0.02 for a, b in zip(ns, ns[1:]))
        print(f"  t{ti} '{name}' ch{chans}: {len(ns)} notes, mean {sum(n[2] for n in ns)/len(ns):.1f}, {min(n[2] for n in ns)}-{max(n[2] for n in ns)}, mono={mono}, first {ns[0][0]:.2f}s")
