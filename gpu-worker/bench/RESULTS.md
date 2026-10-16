# Precise-scoring benchmark (GPU worker)

- Date: 2026-10-16T17:39:07+03:00
- Worker hardware: RTX 3070 Ti 8 GB, driver 610.74, Windows 10 19045, PyTorch 2.11.0 + CUDA 12.8
- Models: torchcrepe full (pitch); openai-whisper large-v3-turbo (words, fp16, beam 5); htdemucs only in speaker mode (no case here)
- Server: test API `http://127.0.0.1:8091` (branch `wt/bench`), scoring `precise-1`, deadline 20 s after finish
- Songs: cn-earth, cn-wonder, va-angel, jw-oh-mallory, jw-little-tomcat, jw-same-boat
- Command: `uv run python bench/run_bench.py --hardware 'RTX 3070 Ti 8 GB, driver 610.74, Windows 10 19045, PyTorch 2.11.0 + CUDA 12.8' --models 'torchcrepe full (pitch); openai-whisper large-v3-turbo (words, fp16, beam 5); htdemucs only in speaker mode (no case here)' --out bench/RESULTS.md --json bench/results.json`

Every take is the length of the song, streamed as 16 kHz mono PCM16 in 5 s chunks through the
browser endpoints, with a fresh guest each time. Latency is from the `finish` response to the
first poll that returned a final status (poll every 0.25 s). Axes are before caps;
"Uncapped" is 100 x the weighted axes (scoring-core weights 0.45/0.25/0.15/0.15), i.e. the score
the take would get without a cap. "Guide bleed" is the worker's own measure (`perepev_worker.bleed`,
0..1, cap at >= 0.45) recomputed by the bench on the same take, because the API does not return it.

"Rhythm" is the server's blended «Ритм и слова» axis: when words are checked (every take here),
`axes.rhythm = 0.5 x pitch rhythm + 0.5 x wordsScore` (scoring-core `precise.rs`), where wordsScore
averages, per lyric word, how surely it was sung times its onset timing after the lag.

The test API ran with `TRUST_PROXY=true`, and this run sent each take from its own
`X-Forwarded-For` address in 198.18.0.0/15 (then the default; now opt-in with `--spread-ips`), because
the API allows 30 performances per hour per client and a run sends 54. The "Server" line above is the
server actually used: a local test API reached by the GPU PC through an SSH reverse tunnel.

## Headline

**48/48 stand-in cases pass; `perfect` gets the bleed cap on 6/6 by design** (the take is a sample
copy of the guide stem, which is what the speaker-bleed check exists to catch). The cn-wonder
`delay400` row with wordsSung 0.00 is undiagnosed and not representative (see finding 2).

## Cases

| Case | Take | Mode | Expectation |
|---|---|---|---|
| perfect | guide vocal as is | headphones | score >= 85, no bleed cap |
| shift+3 | guide pitch-shifted +3 semitones (phase vocoder) | headphones | score >= 85 |
| shift-3 | guide pitch-shifted -3 semitones (phase vocoder) | headphones | score >= 85 |
| delay400 | guide 400 ms late | headphones | rhythm < perfect |
| detune | the longest phrase sung +/-1 semitone off, alternating every 0.5 s; the rest as is | headphones | intervals < perfect |
| other-vocal | guide vocal of the next bench song in the same language | headphones | cap "words", score <= 40 |
| hum | sine following the reference melody | headphones | cap "words", score <= 40 |
| silence | digital silence | headphones | score < 20 |
| bleed | user silent; instrumental + guide from a speaker at -6 dB, 25 ms late | headphones | cap "bleed", score <= 30 |

## Results

| Song | Case | Status | Score | Uncapped | Intervals | Rhythm | Stability | Coverage | wordsSung | Cap | Guide bleed | Latency, s | Expectation |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| cn-earth | perfect | done | 30.0 | 97.9 | 0.98 | 0.97 | 0.99 | 0.98 | 0.95 | bleed | 1.00 | 2.9 | **FAIL** |
| cn-earth | shift+3 | done | 96.6 | 96.6 | 0.98 | 0.92 | 0.99 | 0.98 | 0.86 | — | 0.00 | 2.6 | PASS |
| cn-earth | shift-3 | done | 95.6 | 95.6 | 0.97 | 0.90 | 0.99 | 0.97 | 0.81 | — | 0.00 | 2.1 | PASS |
| cn-earth | delay400 | done | 26.0 | 26.0 | 0.23 | 0.10 | 0.04 | 0.82 | 0.95 | bleed | 1.00 | 2.6 | PASS |
| cn-earth | detune | done | 30.0 | 84.6 | 0.83 | 0.93 | 0.62 | 0.98 | 0.86 | bleed | 1.00 | 2.3 | PASS |
| cn-earth | other-vocal | done | 17.9 | 17.9 | 0.14 | 0.09 | 0.08 | 0.53 | 0.05 | words | 0.00 | 2.6 | PASS |
| cn-earth | hum | done | 40.0 | 86.1 | 0.98 | 0.50 | 1.00 | 0.98 | 0.00 | words | 0.00 | 1.8 | PASS |
| cn-earth | silence | done | 0.0 | 0.0 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | coverage | 0.00 | 1.6 | PASS |
| cn-earth | bleed | done | 30.0 | 59.0 | 0.58 | 0.38 | 0.99 | 0.58 | 0.10 | bleed | 1.00 | 1.8 | PASS |
| cn-wonder | perfect | done | 30.0 | 94.3 | 0.94 | 0.93 | 0.99 | 0.94 | 0.96 | bleed | 1.00 | 3.6 | **FAIL** |
| cn-wonder | shift+3 | done | 93.1 | 93.1 | 0.94 | 0.88 | 0.99 | 0.94 | 0.92 | — | 0.00 | 3.4 | PASS |
| cn-wonder | shift-3 | done | 93.8 | 93.8 | 0.94 | 0.89 | 0.99 | 0.95 | 0.88 | — | 0.00 | 3.4 | PASS |
| cn-wonder | delay400 | done | 19.8 | 19.8 | 0.19 | 0.03 | 0.04 | 0.65 | 0.00 | bleed | 1.00 | 2.3 | PASS |
| cn-wonder | detune | done | 30.0 | 82.7 | 0.83 | 0.90 | 0.59 | 0.94 | 0.96 | bleed | 1.00 | 3.1 | PASS |
| cn-wonder | other-vocal | done | 16.9 | 16.9 | 0.17 | 0.00 | 0.15 | 0.48 | 0.08 | words | 0.00 | 3.1 | PASS |
| cn-wonder | hum | done | 40.0 | 86.6 | 0.98 | 0.50 | 1.00 | 0.99 | 0.00 | words | 0.00 | 2.3 | PASS |
| cn-wonder | silence | done | 0.0 | 0.0 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | coverage | 0.00 | 1.8 | PASS |
| cn-wonder | bleed | done | 30.0 | 51.6 | 0.44 | 0.38 | 0.99 | 0.48 | 0.21 | bleed | 1.00 | 2.4 | PASS |
| va-angel | perfect | done | 30.0 | 92.6 | 0.96 | 0.81 | 0.99 | 0.96 | 0.96 | bleed | 1.00 | 3.4 | **FAIL** |
| va-angel | shift+3 | done | 91.1 | 91.1 | 0.92 | 0.83 | 0.99 | 0.93 | 0.92 | — | 0.00 | 2.9 | PASS |
| va-angel | shift-3 | done | 87.1 | 87.1 | 0.86 | 0.82 | 0.98 | 0.88 | 0.88 | — | 0.00 | 3.1 | PASS |
| va-angel | delay400 | done | 30.0 | 65.4 | 0.50 | 0.75 | 0.86 | 0.75 | 0.96 | bleed | 1.00 | 3.1 | PASS |
| va-angel | detune | done | 30.0 | 86.5 | 0.85 | 0.80 | 0.94 | 0.94 | 0.88 | bleed | 1.00 | 3.1 | PASS |
| va-angel | other-vocal | done | 21.5 | 21.5 | 0.25 | 0.02 | 0.15 | 0.51 | 0.04 | words | 0.00 | 2.9 | PASS |
| va-angel | hum | done | 40.0 | 64.0 | 0.65 | 0.41 | 0.99 | 0.65 | 0.00 | words | 0.00 | 2.3 | PASS |
| va-angel | silence | done | 0.0 | 0.0 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | coverage | 0.00 | 1.8 | PASS |
| va-angel | bleed | done | 30.0 | 50.9 | 0.46 | 0.34 | 0.97 | 0.47 | 0.12 | bleed | 1.00 | 2.3 | PASS |
| jw-oh-mallory | perfect | done | 30.0 | 97.7 | 0.99 | 0.94 | 0.99 | 0.99 | 0.94 | bleed | 1.00 | 2.6 | **FAIL** |
| jw-oh-mallory | shift+3 | done | 96.8 | 96.8 | 0.98 | 0.94 | 0.98 | 0.98 | 0.94 | — | 0.00 | 2.6 | PASS |
| jw-oh-mallory | shift-3 | done | 96.0 | 96.0 | 0.96 | 0.94 | 0.99 | 0.96 | 0.94 | — | 0.00 | 2.3 | PASS |
| jw-oh-mallory | delay400 | done | 25.9 | 25.9 | 0.22 | 0.16 | 0.02 | 0.80 | 0.94 | bleed | 1.00 | 2.6 | PASS |
| jw-oh-mallory | detune | done | 30.0 | 90.5 | 0.86 | 0.94 | 0.90 | 0.98 | 0.94 | bleed | 1.00 | 2.4 | PASS |
| jw-oh-mallory | other-vocal | done | 31.0 | 31.0 | 0.33 | 0.22 | 0.13 | 0.58 | 0.19 | words | 0.00 | 2.1 | PASS |
| jw-oh-mallory | hum | done | 40.0 | 84.8 | 0.96 | 0.50 | 0.99 | 0.96 | 0.00 | words | 0.00 | 1.8 | PASS |
| jw-oh-mallory | silence | done | 0.0 | 0.0 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | coverage | 0.00 | 1.3 | PASS |
| jw-oh-mallory | bleed | done | 30.0 | 73.4 | 0.70 | 0.91 | 0.52 | 0.74 | 1.00 | bleed | 1.00 | 2.6 | PASS |
| jw-little-tomcat | perfect | done | 30.0 | 97.5 | 0.97 | 0.97 | 0.99 | 0.97 | 0.95 | bleed | 1.00 | 3.4 | **FAIL** |
| jw-little-tomcat | shift+3 | done | 98.9 | 98.9 | 0.99 | 0.98 | 1.00 | 0.99 | 0.97 | — | 0.29 | 3.1 | PASS |
| jw-little-tomcat | shift-3 | done | 97.0 | 97.0 | 0.96 | 0.97 | 0.99 | 0.96 | 0.95 | — | 0.00 | 3.4 | PASS |
| jw-little-tomcat | delay400 | done | 28.5 | 28.5 | 0.27 | 0.01 | 0.32 | 0.74 | 0.92 | bleed | 1.00 | 3.1 | PASS |
| jw-little-tomcat | detune | done | 30.0 | 90.4 | 0.84 | 0.97 | 0.91 | 0.98 | 0.95 | bleed | 1.00 | 3.1 | PASS |
| jw-little-tomcat | other-vocal | done | 26.8 | 26.8 | 0.30 | 0.00 | 0.15 | 0.73 | 0.08 | words | 0.00 | 2.6 | PASS |
| jw-little-tomcat | hum | done | 40.0 | 83.6 | 0.94 | 0.50 | 1.00 | 0.94 | 0.00 | words | 0.00 | 2.3 | PASS |
| jw-little-tomcat | silence | done | 0.0 | 0.0 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | coverage | 0.00 | 1.8 | PASS |
| jw-little-tomcat | bleed | done | 30.0 | 92.2 | 0.88 | 0.97 | 0.99 | 0.89 | 0.95 | bleed | 1.00 | 3.4 | PASS |
| jw-same-boat | perfect | done | 30.0 | 96.2 | 0.99 | 0.89 | 0.99 | 0.99 | 1.00 | bleed | 1.00 | 3.4 | **FAIL** |
| jw-same-boat | shift+3 | done | 96.1 | 96.1 | 0.98 | 0.89 | 0.99 | 0.99 | 1.00 | — | 0.00 | 3.4 | PASS |
| jw-same-boat | shift-3 | done | 95.1 | 95.1 | 0.96 | 0.90 | 0.99 | 0.96 | 1.00 | — | 0.00 | 3.4 | PASS |
| jw-same-boat | delay400 | done | 30.0 | 42.5 | 0.43 | 0.19 | 0.40 | 0.82 | 1.00 | bleed | 1.00 | 3.4 | PASS |
| jw-same-boat | detune | done | 30.0 | 90.7 | 0.91 | 0.89 | 0.85 | 0.98 | 1.00 | bleed | 1.00 | 3.6 | PASS |
| jw-same-boat | other-vocal | done | 9.9 | 9.9 | 0.10 | 0.01 | 0.00 | 0.33 | 0.07 | words | 0.00 | 3.4 | PASS |
| jw-same-boat | hum | done | 40.0 | 84.7 | 0.96 | 0.50 | 0.99 | 0.96 | 0.00 | words | 0.00 | 2.9 | PASS |
| jw-same-boat | silence | done | 0.0 | 0.0 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | coverage | 0.00 | 2.0 | PASS |
| jw-same-boat | bleed | done | 30.0 | 35.9 | 0.39 | 0.29 | 0.00 | 0.74 | 1.00 | bleed | 1.00 | 3.4 | PASS |

## Summary by case

| Case | Passed | Median score | Median latency, s | Max latency, s |
|---|---|---|---|---|
| perfect | 0/6 | 30.0 | 3.4 | 3.6 |
| shift+3 | 6/6 | 96.3 | 3.0 | 3.4 |
| shift-3 | 6/6 | 95.3 | 3.2 | 3.4 |
| delay400 | 6/6 | 27.2 | 2.9 | 3.4 |
| detune | 6/6 | 30.0 | 3.1 | 3.6 |
| other-vocal | 6/6 | 19.7 | 2.7 | 3.4 |
| hum | 6/6 | 40.0 | 2.3 | 2.9 |
| silence | 6/6 | 0.0 | 1.8 | 2.0 |
| bleed | 6/6 | 30.0 | 2.5 | 3.4 |

All takes: 54; final `done`: 54; not done (offline/failed/timeout/error): 0.
Latency over done takes: median 2.6 s, max 3.6 s.

Raw per-take data (all result fields except the curves): `bench/results.json`.

## Findings (written by hand for this run; not generated)

Expectations: 48 of 54 pass. All 6 failures are the same one: `perfect` gets the bleed cap. No
threshold was changed to make a case pass.

**Caveats.** The stand-ins are idealised. The `shift+3` / `shift-3` takes are phase-vocoded copies of
the separated reference vocal, so their 87-99 is a ceiling for a real singer, not an estimate. The
`bleed` take is a clean, delayed copy of the stems, with no room acoustics, speaker filtering or
browser echo cancellation, and it runs in headphones mode (the only mode in which the app plays the
guide). `hum` is a pure sine. Two `other-vocal` donors are shorter than the song and zero-padded
(cn-earth, 13.87 s, under va-angel; jw-oh-mallory, 13.97 s, under jw-same-boat). Latencies were
measured one job at a time over a local SSH tunnel, so they are a best case. The "measured
separately" numbers in finding 5 (first job, speaker mode, a burst of 6) are manual observations from
separate runs and are not in `results.json`.

1. **perfect: bleed cap on 6/6 (score 30.0; uncapped 92.6-97.9).** The take is a sample-exact copy
   of `guide.mp3`, and the speaker-bleed check (GCC-PHAT waveform correlation, cap at guide >= 0.45)
   exists to catch exactly that: guide bleed is 1.00 on every song. The expectation "perfect must not
   get a bleed cap" cannot hold for a copy of the stem without disabling the anti-cheat check. A take
   that is not a copy of the stem, `shift+3` / `shift-3` (phase vocoder), scores 87.1-98.9 with guide
   bleed 0.00-0.29 and no cap. A real voice singing along in headphones was not available, so the
   headphones false-positive question is answered only by these stand-ins.
2. **delay400: the blended rhythm axis drops as expected (0.01-0.75 vs 0.81-0.97), but the whole
   score collapses** (uncapped 19.8-65.4; intervals 0.19-0.50, stability 0.02-0.86). scoring-core
   searches the lag only within +-0.3 s (`MAX_LAG`). With the take 0.4 s late, the chosen lag is
   arbitrary (-0.30 ... +0.23 s) and changes between runs (va-angel: uncapped 33.0 in the first run,
   65.4 here). Both halves of the blended axis fall. Word timing is scored after that lag, so it drops
   (wordsScore 0.00-0.37 vs 0.77-0.94; va-angel about unchanged, 0.78 -> 0.79). The pitch-rhythm half falls at
   least as far, from 1.00 to 0.00-0.23 on five songs. Recovered as `2 x rhythm - wordsScore`, it drops
   further than wordsScore on 5 of 6 songs and about equally on jw-oh-mallory. So the drop is not
   mostly word timing. A singer whose recording is offset by more than 0.3 s (for example, uncompensated
   Bluetooth output latency) loses most of the score. The cn-wonder `delay400` row (wordsSung 0.00)
   repeated in both runs and in two more single reruns, while the other songs kept 0.92-1.00. Its cause
   is undiagnosed (the API does not return the recognised text), so it is not representative.
3. **detune: intervals drop** (0.83-0.91 vs 0.94-0.99 for perfect), stability too (0.59-0.94);
   uncapped 82.7-90.7. One badly sung phrase costs about 5.5-13.3 points (perfect minus detune,
   uncapped, from the table: cn-earth 13.3, cn-wonder 11.6, va-angel 6.1, jw-oh-mallory 7.2,
   jw-little-tomcat 7.1, jw-same-boat 5.5).
4. **other-vocal**: words cap 6/6, score 9.9-31.0. **hum**: words cap 6/6 at exactly 40.0 (uncapped
   64.0-86.6: the melody is right, the cap is what holds the score at 40). Its blended rhythm is 0.50
   because the sine has perfect note timing (pitch rhythm 1.00) and no words (wordsScore 0.00):
   0.5 x 1.00 + 0.5 x 0.00. va-angel shows 0.41 because pitch rhythm is scaled by coverage / 0.8, and
   the hum covers 0.65 there. **silence**: 0.0 (coverage cap). **bleed**: bleed cap 6/6, score 30.0.
5. **Latency**: every take was final 1.3-3.6 s after `finish` (deadline 20 s). Measured separately
   on the same PC: the first job after a worker start 4.7 s; speaker mode (htdemucs + whisper) on
   29.4-29.7 s songs 4.2-4.4 s; six takes finished at the same moment are processed one after another
   (about 3.1 s each), the sixth was done at 19.1 s, so a seventh simultaneous one would miss the
   deadline and show the provisional score.
