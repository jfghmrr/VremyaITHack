# Perepev hackathon upgrade: design

Date: 2026-10-16. Status: draft for owner approval.
Base version: the packaged archive `Perepev-Docker-2026-10-16.zip` (source commit `6e92e72`, app base `041344f`), which is newer than this repository's `main` (`a8b5f4d`, 2026-10-14).

## 1. Intent

Perepev is a browser karaoke game: you sing a short fragment, it compares your melody and rhythm with the original, in any key, and scores it. The team will defend it at a hackathon. It will be shown live on phones and on a public site, `perepev.lumnex.ru`.

The upgrade makes the demo convincing in five ways:

- It works and looks right on any screen, above all on iPhone and Android in portrait and landscape, including while singing.
- It looks like a service that follows Russian law.
- It has a fuller catalog of easy, well-known songs with vocals.
- Anyone can sing any song they bring ("sing your own track").
- The score really reflects how close the singing was to the original, including whether the words were sung.

Success for the owner: judges can open the site on their own phones, pick a familiar song or upload their own, sing, and get a believable, fun result within seconds.

## 2. Goals, non-goals, anti-goals

**Goals**

1. A Russian, on-brand error page (404 and other errors).
2. A responsive layout for phones (portrait and landscape), tablets, laptops, large and ultra-wide monitors. Nothing overlaps or shifts, and singing works on phones.
3. Demo-grade compliance with Russian law: every mechanism and page a compliant site would have, with operator details as a team stub.
4. A catalog of 50 songs with vocals: the existing 24 plus 26 new, legally free, well-known and easy to sing.
5. "Sing your own track": upload any song file, which is processed on the team's GPU PC into a private, karaoke-ready song.
6. More accurate scoring: neural pitch tracking plus recognition of the sung words, run on the GPU PC, with automatic fallback to the current in-browser scoring.
7. A Windows PowerShell (admin) script that turns the team's PC into the GPU worker.
8. Deployment to `perepev.lumnex.ru` once the server is reachable.

**Non-goals**

- Changing how live duels and rated matches are scored. They keep the server-side curve scoring and only benefit from better client pitch tracking.
- Real legal registration (Roskomnadzor notification, contracts, licences), a real legal entity, or song licences.
- Native mobile apps, chat, recommendations.

**Anti-goals** (a failure even if everything technically works)

- The demo stalls because the GPU PC is off or slow.
- Copyrighted hit recordings sourced by us and published on the site. Hits appear only through the user's own private upload.
- Fabricated legal identifiers: fake INN/OGRN, Roskomnadzor registry numbers or addresses.
- A score that is easy to game: humming without words, silence, or a constant tone.
- A long, tedious list of scoring criteria.

## 3. Constraints

- **Hardware:**
  - The main server has no GPU. It is reachable as `46.39.20.24`, SSH port 2222, located in Russia per IP geolocation.
  - The GPU PC runs Windows with an RTX 3070 Ti (8 GB), 32 GB RAM and an i5 14th gen. It is behind NAT and may be offline.
- **Server status on 2026-10-16:** TCP ports 80, 443 and 2222 accept connections, but nothing answers (SSH banner timeout, no HTTP response). Deployment is blocked until the owner fixes this.
- **Clients:** iPhone Safari and Android Chrome first, then desktop Chrome/Edge. Real-device testing is the owner's; we test with Playwright Chromium and WebKit device emulation.
- **Law** (research of 2026-10-16; full table in §9):
  - Russian users may sign in only through permitted methods (149-FZ Art. 8 part 10), so Google sign-in is out.
  - Personal data must be stored in Russia, including on the GPU PC.
  - The site is meant for all ages, so lyrics must suit 0+/6+ and foreign-agent artists are excluded.
- **Copyright:** we add only songs whose composition, lyrics and recording are all free to use (public domain or free licences). User uploads stay private to the uploader and are deleted after 24 hours. The full file never leaves the device: only the chosen section is uploaded.
- **Licences of models and code:**
  - Non-commercial use is acceptable for this demo, but avoid unlicensed weights and copyleft code.
  - Do not use MMS aligner weights, the viperx/UVR "karaoke" weights, TEN VAD or Essentia.js.
- **Project conventions:**
  - Rust (Axum, SQLx), SvelteKit 3 static build and Caddy.
  - Existing tests must keep passing.
  - Commit titles are short and in Russian, with no body.
  - Context documentation is in English, kept in the repo (see §10).

## 4. Decisions made with the owner

| Topic | Decision |
|---|---|
| Purpose | Hackathon defense only |
| Where to work | This repository (`/Volumes/smokkkkiiii/Projects/Perepev`); test every change right away |
| Popular hits | Through "sing your own track" only; we do not download or host hits |
| Catalog size | 50 songs in total, free to use, popular and easy to sing |
| Audience | All ages, every generation |
| Legal | A stub that looks fully compliant; operator details may be a stub |
| Sign-in | Yandex ID and VK ID (Google dropped because of 149-FZ Art. 8 part 10) |
| Demo access | Public site, no password |
| Scoring goal | The user's singing should resemble the original; word recognition is part of a criterion, not a long list |
| GPU | The owner's Windows PC, set up by a PowerShell script the owner runs as admin |
| Processing location | Voice may go to the server and GPU PC for analysis |
| Devices | iPhone and Android most important; portrait and landscape; singing should work on phones |

## 5. What gets built

### 5.0 Baseline

1. Import the archive version into this repository as one commit on branch `hackathon-upgrade`. The archive has the newer code, 24 vocal songs, the friends feature and its docs. Keep files that exist only here if they are still referenced (e.g. `crates/api/tests`); otherwise prefer the archive. Do not import `MANIFEST.sha256` or `PACKAGE_INFO.json`.
2. Build and run the full existing test set.
3. During development, test on an isolated Compose project. Update the owner's local install on port 8080 (Compose project `kvinta`) only after a database backup. It currently runs the old 23-song build with the owner's data; migration `0003_friends` is additive.

### 5.1 Error page

A new `web/src/routes/+error.svelte` in the room style (paper card, cat):

- 404: «Такой страницы нет», with links to the home page and to songs.
- Other errors: a generic Russian message and a retry action.
- The page keeps the normal navigation and footer.

### 5.2 Responsive layout

**Problem today:**
- All layouts switch only on width (12 different `max-width` values, mostly 900px).
- "Scene" pages place elements absolutely at percentage positions inside `100svh - chrome`.
- There are no orientation or height queries. A phone in landscape (e.g. 932×430) gets the desktop absolute layout squeezed into about 320px of height.

**Target device matrix** (all must pass):

| Group | Sizes |
|---|---|
| Phones, portrait | 360×740, 375×667, 390×844, 393×852, 412×915, 430×932 |
| Phones, landscape | 667×375, 844×390, 852×393, 932×430 |
| Tablets | 768×1024, 820×1180, 1024×1366 (portrait); 1024×768, 1180×820, 1366×1024 (landscape) |
| Desktops | 1280×720, 1366×768, 1440×900, 1536×864, 1920×1080, 2560×1440, 3440×1440, 3840×2160 |

**Approach:**
- Introduce shared layout breakpoints that combine width, height and orientation:
  - compact (phone portrait)
  - short landscape (height under about 500px)
  - medium (tablet)
  - wide (desktop)
  - extra-wide (2560px and up, or aspect ratio over 2.1)
- Scene pages fall back to flowing layouts whenever there is not enough width or height, not only width.
- On extra-wide screens, content is centred and scaled with `clamp()` so it doesn't look tiny.
- Use `dvh`/`svh` correctly and `env(safe-area-inset-*)` for notches and home indicators. Touch targets are at least 44px.
- Orientation changes are pure re-layout: never restart audio or recreate the AudioContext.
- Highest priority: the sing screen (mic check, stage), result, songs and home on phones in both orientations.
  - **Portrait:** lyrics on top, pitch line, controls at the bottom.
  - **Landscape:** lyrics on the left, pitch line and controls on the right, decorative elements hidden.
  - Request the Screen Wake Lock while singing.
- iOS audio:
  - Use `navigator.audioSession.type = "play-and-record"` where it exists.
  - Start the context and microphone from a tap.
  - Keep echo cancellation, noise suppression and auto gain off.
  - The headphones warning stays.

**Acceptance:**
- An automated Playwright check runs every main route on the whole matrix, in Chromium and WebKit device emulation. It requires:
  - no horizontal scroll;
  - no overlap between interactive controls (bounding-box test);
  - the primary action of each screen visible without scrolling on stage screens;
  - no clipped text in navigation.
- Screenshots of the matrix are reviewed by eye.

### 5.3 Legal compliance (demo grade)

These items come from §9; each lists the change.

- **Sign-in:**
  - Add Yandex ID (OAuth 2.0 code flow with PKCE, `oauth.yandex.ru`, profile from `login.yandex.ru/info`) and VK ID (OAuth 2.1 with mandatory PKCE, `id.vk.ru/authorize`, `id.vk.ru/oauth2/auth`, `id.vk.ru/oauth2/user_info`).
  - Keep the existing email and password login as the team's own system, which experts consider permitted.
  - No Google.
  - Buttons appear only when the provider's credentials are configured.
- **Accounts for provider users:**
  - Add an `identities(provider, subject, user_id)` table.
  - `email` and password become optional for provider-only users.
  - Deleting an account or changing a password without a password uses a typed confirmation phrase.
  - Consent (with version) is required for every sign-up path.
- **Public names:**
  - Leaderboard and friends show only the in-game nickname. The name field is relabelled as a public nickname, and the consent text covers showing it.
  - New provider users get a neutral generated nickname, not their real name.
- **Children:** sign-up asks whether the person is 14 or older. Under 14 requires a parent or guardian confirmation checkbox and the parent's name, stored with the consent.
- **Age labels:** a site label (6+) in the footer and a label on each song card.
- **Voice processing:**
  - The consent and privacy policy describe uploading recordings for scoring and processing on the team's PC in Russia.
  - Recordings are deleted right after scoring.
  - There is no identification or voiceprints.
- **Own tracks:**
  - The terms say the user warrants their rights to the file.
  - Uploads are private and deleted after 24 h.
  - A rights-holder complaint form, stored server-side, is linked from the footer.
- **New pages:** «Пользовательское соглашение» (`/legal/terms`) and «Контакты» (`/legal/contacts`), the latter with the operator stub and the complaint form. Privacy and consent are updated, and their document versions bumped in both `operator.ts` and `CONSENT_VERSION`.
- **Content rules for the catalog:** song import checks lyrics against a profanity and banned-topic list, and the artist and authors against the foreign-agent and extremist lists (manual check recorded in `CREDITS.json`).
- **Hosting hygiene:** no third-party scripts, fonts or CDNs (already true). Add an HSTS header on the HTTPS server config.
- **Russian language:** check for English UI words (e.g. "VS", "REC") and translate them or pair them with Russian. Song titles and decorative art text stay.
- **Operator stub:**
  - Operator name «Команда mugsize».
  - Contact through the site's form.
  - No invented registration numbers or addresses.
  - The privacy policy keeps an honest placeholder sentence that the Roskomnadzor notification is filed by the operator before a public launch.

### 5.4 Catalog to 50 songs

- Keep the 24 current vocal songs.
- Add 26 new songs, roughly half Russian and half English. Each must satisfy all of these:
  - The composition and lyrics are public domain in Russia (authors died before 1956, or traditional).
  - The recording is public domain, CC0, CC BY or CC BY-SA (CC BY-NC only as a fallback; never ND).
  - It has a clear lead vocal and decent audio quality.
  - The lyrics suit all ages.
  - It is widely known and easy to sing.
- The candidate list comes from the research of 2026-10-16. Each licence must be re-verified on the source page at download time and recorded in `CREDITS.json`.
- **Processing:** use the new GPU pipeline (§5.6), the same one used for uploads, through a catalog import command. Keep a 15-60 s clip, take the reference melody from RMVPE on the separated vocal, and get word timings from ASR plus forced alignment against the known lyrics. Lyrics of public-domain songs are typed from public-domain sources and checked against the recording.
- The 25 old instrumental song folders stay as they are, outside the active index (compatibility).

### 5.5 Sing your own track

User flow (sign-in required; at most 5 uploads per user per day):

1. Choose a file (mp3, m4a, aac, wav, ogg or flac, up to 30 MB) and the language (Russian or English).
2. In the browser, the file is decoded and shown as a waveform. The user picks a 15-60 s section; we suggest one around the first loud vocal passage.
3. Only that section, plus 2 s margins, is uploaded as 44.1 kHz mono 16-bit WAV.
4. The GPU worker processes it (§5.6):
   - The UI shows progress: queued, separating, melody, words, ready. Typical time is about one minute.
   - If the worker is offline, the UI says so and keeps the job queued for up to 30 minutes.
5. The song appears under «Мои треки» on the songs page for 24 hours, visible only to its owner. Singing, result and practice work as with catalog songs, with word-by-word highlighting.
6. Obscene words in recognised lyrics are masked on screen.

**Storage:**
- Private files live on the server outside the public `/songs` path. They are served only to the owner through authenticated API routes.
- A periodic cleanup deletes them after 24 h.

### 5.6 GPU worker and scoring

**Worker protocol (pull, outbound only):**
- The PC worker calls `POST /api/worker/lease`, a long-poll of about 25 s, with a per-worker bearer token. The server stores only a hash of the token, and these endpoints are outside the browser CSRF guard.
- Jobs are leased with a TTL and renewed by heartbeat. `complete` is idempotent per job id.
- Inputs and outputs move through short-lived single-use URLs on the server. The server validates result JSON against a schema and enforces size limits.
- The worker is "online" if its heartbeat is under 30 s old; `/api/health` reports it.
- Job types:
  - `score` has priority.
  - `track` (own upload) comes next.
  - `catalog` (team import) comes last.

**Models** (from the research of 2026-10-16; the builder may substitute an equivalent if one fails in measurement):
- **Separation:** Mel-Band RoFormer (Kim weights, MIT) via `python-audio-separator`; fallback `htdemucs` (Demucs 4, MIT).
- **Melody:** RMVPE (Apache-2.0 code) at 10 ms hop with confidence, smoothing and octave-jump correction. It replaces pYIN for references.
- **Words:**
  - Qwen3-ASR-1.7B (Apache-2.0), with the language forced, for recognition.
  - Qwen3-ForcedAligner-0.6B (Apache-2.0) for word times against known lyrics.
  - Fallbacks: faster-whisper large-v3-turbo (MIT) and WhisperX wav2vec2 alignment for Russian and English.
- **Live pitch in the browser:** SwiftF0 (ONNX, about 135 KB, MIT code and weights) on onnxruntime-web WASM, replacing `pitchy` if it keeps up in real time on test devices. Otherwise keep `pitchy`.
- **VRAM budget:** 8 GB. Keep the scoring models resident; load the separator on demand.

**Scoring a solo performance:**
1. While singing, the browser shows the live pitch line and a provisional score as today. It also uploads 16 kHz mono PCM in about 5 s chunks, so the upload is finished when the song ends.
2. On finish, the server enqueues a `score` job. The worker returns the user's F0 frames (RMVPE) and word evidence:
   - forced alignment of the song's known lyrics, giving onset and confidence per word;
   - ASR text without a lyrics prompt, so it cannot echo the lyrics.
3. The server computes the final score with the native `scoring-core` from these inputs. The result page switches from «предварительно» to the final score, typically 4-10 s after the end.
4. The recording is deleted right after the job, or after 10 minutes at most.
5. **Fallback:** if the worker is offline or misses a 20 s deadline, the provisional in-browser score becomes final, labelled «слова не проверены».

**Criteria (still four):**

| Criterion | Weight | Measures |
|---|---|---|
| Мелодия | 45% | The current intervals axis, computed on RMVPE pitch |
| Ритм и слова | 25% | Half the current rhythm axis, half a words score. Words score = mean over lyric words of sung(w) × timing(w). sung(w) blends alignment confidence with a fuzzy match in the ASR text. timing(w) decays as the word onset drifts more than about 200 ms from the reference after latency removal. Without word evidence, rhythm only. |
| Устойчивость | 15% | Current stability, with a 100-150 ms median on pitch so vibrato isn't punished |
| Попадание | 15% | Current coverage |

**Caps:**
- The existing caps stay: low coverage and a constant tone cap the score at 30.
- New: if words are checked and fewer than 30% of words were sung, the score is capped at 40, so humming «ля-ля» can't win.

**Other scoring rules:**
- Key-invariance and ±300 ms latency compensation stay.
- The precise algorithm gets its own version tag stored with attempts. Duel scoring keeps `ALGORITHM_VERSION = 1`.
- The attempt is saved with the final score and a flag saying whether words were checked.

**What the singer hears, and protection against speaker bleed** (builder's call, 2026-10-16):

Today `backing.mp3` is the full mix with the original singer, and echo cancellation is off. A silent judge whose phone speaker plays the song would otherwise be scored on the original singer.

- **Two stems per song.** Every song (catalog and uploads) gets an instrumental and a separated vocal, produced by the same separation step. The existing 24 songs are re-separated from their current `backing.mp3` clips, so no source re-download is needed.
- **Headphones mode (default):** the instrumental plus the original vocal at about −15 dB as a guide. The original full mix stays available as the preview and "listen" track.
- **"Без наушников" mode:** the instrumental only, with echo cancellation on. The user can switch modes on the mic-check screen; the choice is remembered.
- **Bleed check on the worker:** correlate the recording with the played instrumental and the guide vocal (known signals, latency-aligned). If guide-vocal bleed is detected, cap the score at 30 and tell the user to wear headphones or switch mode. The benchmark gets a "speaker on, user silent" case that must score low.

**Guests** (builder's call): guests get precise scoring too.
- Before the microphone starts, a one-tap consent covers processing the voice recording for scoring. It is stored with an anonymous job id and the consent version.
- Guest jobs are rate-limited per IP and per browser.
- Audio upload routes accept binary audio with their own size limits, separate from the 16 KB JSON guard. They keep the Origin and marker-header checks.

**Validation without human recordings:**
- Build a benchmark from the catalog itself. Use the separated original vocal of each song as a "perfect singer" and apply these transforms:
  - pitch-shift ±3 or ±5 semitones;
  - a global delay;
  - local detuning of a phrase;
  - time-stretching a phrase;
  - another song's vocal over this song (wrong words);
  - a sine-wave hum of the reference melody;
  - silence and noise.
- Expected ordering:
  - the perfect and shifted versions score highest (≥ 85);
  - detuned or late versions drop on the matching criterion;
  - wrong words and humming are capped;
  - silence and noise score low.
- The benchmark runs as a test of the scoring pipeline with recorded fixtures (no GPU needed in CI), plus one live run on the GPU PC.

### 5.7 Windows setup script

`deploy/gpu-worker/setup.ps1`, run as administrator:

1. Check Windows version, NVIDIA driver and GPU (`nvidia-smi`), and free disk space.
2. Install, idempotently, `uv` (Python manager), Python 3.12 and ffmpeg through `winget` where available.
3. Create the worker directory, install CUDA PyTorch and the worker's pinned dependencies, and download the models into a local cache.
4. Ask for the server URL and the worker token, stored with Windows DPAPI (user-scoped, not in plain text).
5. Run a self-test on a bundled 5 s clip.
6. Register a Task Scheduler task that starts the worker at boot and restarts it on failure.
7. Print status and how to uninstall (`setup.ps1 -Uninstall`).

The script never opens inbound ports. A companion `README.md` explains it in Russian for the team. The worker code itself is Python, under `gpu-worker/`, with its own tests that run on CPU with tiny fixtures.

### 5.8 Deployment

- Use the existing `compose.server.yaml` path with `SITE_DOMAIN=perepev.lumnex.ru` (the DNS A record already points to 46.39.20.24). Caddy obtains HTTPS automatically.
- Secrets live in the server's `.env` and never in the repository:
  - database password
  - worker token hash
  - Yandex and VK client credentials
- Deploy only after the owner confirms the server is reachable. Back up first if data exists.

## 6a. One-day delivery (defense is on 2026-10-17)

The owner said on 2026-10-16 that the defense is tomorrow and the work must be done today. If free recordings run short, the catalog shrinks rather than losing its Russian half. This section overrides the rest of the document where they conflict.

**Simplifications (builder's call, to cut installation and integration risk on Windows):**
- **Live pitch:** keep `pitchy` in the browser; SwiftF0 is deferred.
- **Melody on the worker:** use `torchcrepe` (MIT, pip-installable weights) for both references and user recordings. RMVPE is optional if it installs cleanly.
- **Words:** `faster-whisper` large-v3-turbo with word timestamps (`small` on CPU). Recognised words are matched to the known lyric words by fuzzy sequence alignment, which gives sung(w) and timing(w). Qwen3-ASR/ForcedAligner are deferred.
- **Separation:** `htdemucs` (Demucs 4, MIT) as the dependable default; Mel-Band RoFormer only if `audio-separator` installs cleanly.
- **The worker is cross-platform Python.** Catalog processing (stems for the existing 24 songs and new songs) runs now on the Mac (CPU/MPS), so it does not depend on the PC. The Mac can also act as a backup worker during the defense.

**Must-have for the defense, in order:**
1. Baseline import, the error page, and phone portrait/landscape layouts of home, songs, sing, result.
2. Legal pages and mechanics (terms, contacts and complaint form, nickname wording, age gate checkbox, voice consent, age labels, HSTS).
3. Worker system and own-track upload, end to end.
4. Precise scoring with words, bleed check, fallback.
5. Yandex ID and VK ID sign-in. Code and tests with mocked providers; the live buttons need the owner's credentials.
6. Windows `setup.ps1`.
7. New catalog songs that pass the free-licence rules; fewer than 26 is acceptable.
8. Tablet and desktop matrix polish, and the full device matrix.

**Dropped first if time runs out:**
- the full 24-size matrix in both engines: keep about 10 key sizes;
- the depth of the scoring benchmark: keep perfect, shifted, hum, silence, wrong words and speaker bleed;
- the under-14 parent-name field: keep the checkbox;
- new catalog songs.

## 6. Order of work

1. Baseline import and green tests.
2. Error page.
3. Responsive layout and the device-matrix check (the largest UI item; it gets early attention because everything else is shown on phones).
4. Legal mechanics and pages, and the sign-in providers (behind configuration).
5. Worker protocol and server side (jobs, storage, cleanup, health), with a fake worker for tests.
6. GPU worker (Python) with the models: catalog import, own-track pipeline, score pipeline. Developed and smoke-tested on the Mac (CPU/MPS), then on the PC.
7. Precise scoring in `scoring-core` with the words component and caps, plus the benchmark.
8. "Sing your own track" UI.
9. Catalog to 50 (needs the worker).
10. Windows setup script.
11. Full regression: existing e2e suite, crawl, matrix, API checks. Then local install update and server deployment.

Each step ends with its tests passing and the affected screens checked in the browser.

## 7. Left to the builder

- Exact breakpoint values and per-page layout details, as long as the device matrix passes and the room style is preserved.
- UI copy details (Russian, friendly, short).
- File formats between server and worker, job storage (Valkey or PostgreSQL), and polling vs WebSocket for job status.
- Model substitutions within §3 licence rules if a model fails measurement (speed, VRAM, quality). Record the measurement.
- Thresholds for word timing decay and confidence (validate with the benchmark).
- How the upload section is suggested.

## 8. Needs the owner

1. **OAuth credentials:**
   - Register an app at `oauth.yandex.ru` with the redirect `https://perepev.lumnex.ru/api/auth/yandex/callback`.
   - Register a VK ID app (id.vk.ru business account) with the trusted redirect `https://perepev.lumnex.ru/api/auth/vk/callback`.
   - Add the matching `http://localhost:…` redirects for local testing.
   - Provide the client IDs and secrets privately. Step-by-step instructions are shipped in the repo.
2. **Server reachability:** SSH on port 2222 and HTTP on 80/443 currently hang. Also change the SSH password that was shared in chat, and preferably switch to key-based login.
3. **GPU PC:** run `setup.ps1` as administrator and confirm that the PC is in Russia (assumed).
4. **Real phones:** a final check on an iPhone and an Android phone, with headphones.

## 9. Legal research summary (2026-10-16, not legal advice)

- **Sign-in:**
  - 149-FZ Art. 8 part 10 (406-FZ, in force since 01.12.2023) permits only a Russian phone number, ESIA, EBS or a Russian-owned system such as Yandex ID or VK ID. Google is not permitted.
  - Fines apply since 07.07.2026 under КоАП 13.55 (199-FZ).
  - An own email and password system is considered permitted by experts, but there is no official ruling.
- **152-FZ:**
  - A published policy (Art. 18.1).
  - A separate consent document since 01.09.2025 (Art. 9, 156-FZ).
  - Public nicknames only, or a separate consent to dissemination (Art. 10.1).
  - A Roskomnadzor notification by the operator (Art. 22).
  - Localization in Russia (Art. 18 part 5).
  - A processing instruction for the GPU PC owner (Art. 6 part 3).
  - Leak reports within 24 h and 72 h (Art. 21 part 3.1).
  - A voice used only for scoring is ordinary personal data, not biometric (Art. 11).
  - Parents consent for under-14s (Civil Code Art. 28).
- **436-FZ:**
  - An age label is optional for a non-media site but recommended.
  - Lyrics must avoid every category of Art. 5 part 2, including obscene language and foreign-agent content.
- **Russian language:** 168-FZ (from 01.03.2026) applies to consumer information. A free demo is borderline. A Russian UI is enough; titles of works are fine.
- **Foreign agents:** content by registry artists is excluded (255-FZ Art. 9, 11; КоАП 19.5 part 42).
- **User uploads:**
  - Under Civil Code 1253.1, an intermediary is not liable if it acts on notice.
  - 149-FZ 15.7 requires prompt removal on a rights-holder request.
  - Keeping uploads private and short-lived minimises exposure.
- **Copyright:** non-commercial use still needs licences (Civil Code 1270). Organizer permission cannot grant third-party rights. Collective societies do not license online karaoke streaming.

## 10. Documentation to maintain

- The archive's `PROJECT_OVERVIEW.md`, `ARCHITECTURE.md`, `WORK_DONE.md`, `OPERATIONS.md` and README become this repository's context documents. Do not create duplicates.
- Each step updates them, and `WORK_DONE.md` (the change history) gets a dated entry with the actual test results.
- Worker and setup-script docs live next to their code.
