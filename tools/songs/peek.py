import sys
from import_songs import load_midi
N = "C C# D D# E F F# G G# A A# B".split()
name = lambda p: f"{N[p%12]}{p//12-1}"
for sid in sys.argv[1:]:
    notes, bar = load_midi(f"cache/{sid}.mid")
    print(f"== {sid}")
    for ti in sorted({n[3] for n in notes}):
        ns = sorted(n for n in notes if n[3] == ti)[:22]
        print(f"  t{ti}: " + " ".join(f"{name(n[2])}@{n[0]:.1f}" for n in ns))
