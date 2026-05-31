# AI Video Interview Platform

A production-grade, asynchronous, AI-driven video interview platform.

- **Candidates** receive a UUID link, complete a hardware check, then talk live with an AI interviewer (Deepgram Voice Agent) that asks questions, listens to their answers, and verbally responds with Groq-generated feedback.
- **Recruiters** create templates, issue interview links, and review per-question video + transcript + AI score + proctoring flags.

---

## 1. Problem Understanding

**Problem.** Manual first-round screening is the most expensive, least scalable part of hiring. A recruiter doing 8 phone screens a day burns 6 hours producing the same low-signal output for each candidate.

**System need.** We want to:
- Let recruiters set a question bank once, then issue async links to N candidates.
- Capture *high-fidelity* candidate signal: actual video, actual transcript, actual answer audio.
- Provide *immediate AI feedback* during the interview (so the candidate feels like a real conversation, not a webcam-into-the-void).
- Surface a recruiter-ready scorecard with proctoring flags so the recruiter only has to review the top-N.

---

## 2. Architecture Overview

### High level

```
            ┌────────────────────────────────────────────────────────┐
            │                        Browser                         │
            │                                                        │
            │  HardwareCheck → InterviewPage                         │
            │      │              │                                   │
            │      │ getUserMedia │                                   │
            │      ▼              ▼                                   │
            │   <video>      MediaRecorder ──► 5s .webm chunks        │
            │      │                │                                 │
            │      │                ├──► POST /api/chunks/:token  ───┐│
            │      │                │                                 ││
            │      │   ┌────────────┴───────────────┐                 ││
            │      │   │ Deepgram Voice Agent (WS)  │                 ││
            │      │   │   audio in/out + JSON      │                 ││
            │      │   └────────────┬───────────────┘                 ││
            │      │                │ wss://backend/api/voice-agent/  ││
            │      │   Socket.IO ───┴──► proctoring_event             ││
            └──────┼─────────────────────────────────────────────────┘│
                   │                                                  │
                   ▼                                                  │
        ┌──────────────────────────────────────────────────────┐      │
        │                    Express + ws                      │ ◄────┘
        │  REST: /api/auth, /api/sessions, /api/chunks,        │
        │        /api/recruiter                                │
        │  WS proxy: /api/voice-agent/:token → Deepgram        │
        │  Socket.IO: proctoring + recruiter live              │
        └────────────┬─────────────────┬───────────────────────┘
                     │                 │
                     ▼                 ▼
                ┌─────────┐       ┌──────────┐
                │ MongoDB │       │   S3     │ (raw chunks + merged.webm)
                └─────────┘       └────┬─────┘
                     ▲                 │
                     │            ┌────┴────┐
                     └────────────┤ BullMQ  │── Worker process
                                  │ Redis   │   FFmpeg merge + Groq final score
                                  └─────────┘
```

### Media flow

1. **Capture (client):** `getUserMedia` is called **exactly once** on the HardwareCheck page. The resulting `MediaStream` is passed via React Router state into `InterviewPage` so the video track is never re-acquired (which on some browsers ends and dies).
2. **Recording (client):** `MediaRecorder` records video+audio in WebM. It emits a Blob every **5 seconds** (`timeslice`). Each Blob is POSTed to `/api/chunks/:token` as multipart form data.
3. **Voice (client ↔ server ↔ Deepgram):** A separate `WebSocket` opens to our backend's `/api/voice-agent/:token` proxy. Microphone audio is captured separately (via an inline `AudioWorklet` that produces 16k linear PCM) and pushed upstream as binary WS frames. Deepgram returns binary TTS audio (24k PCM) which is played back through Web Audio API, plus JSON control frames (transcripts, speech state).
4. **Chunk storage (server):** Each chunk is written to S3 with the deterministic key `${sessionId}/${questionIndex}/chunk_${pad3(chunkIndex)}.webm`. The chunk's existence is also recorded on the session document so the worker doesn't depend on S3 listing.
5. **Async processing (worker):** When the candidate finishes, the session is locked + a BullMQ job enqueued. The worker downloads chunks for each question, concatenates them with FFmpeg (`-f concat -c copy`, no re-encode), uploads the merged `.webm` to S3, and writes the merged key back to the session.
6. **Scoring (immediate, per question):** As soon as a question's transcript is captured, the client calls `/api/sessions/:token/answer/review`, which calls Groq (`llama-3.1-8b-instant`) twice in parallel — once for `{score, feedback}` JSON, once for a human-sounding 2-3 sentence spoken review — and persists both. The spoken review is then handed back to the Voice Agent to speak aloud.
7. **Recruiter retrieval:** Recruiter dashboard polls the session detail every 5s while in `processing`. Merged videos are served via pre-signed S3 URLs (1h TTL).

### WebSocket/event flow

- **Socket.IO (proctoring):** Client emits `join_session({token})` then `proctoring_event(...)`. Server saves to MongoDB and fan-outs to `recruiter_${sessionId}` rooms for live dashboards.
- **Native WS (voice agent proxy):** Two-way piping between client and `agent.deepgram.com/agent`. The server sniffs JSON frames to extract transcripts and persist them per-question — so even if the client disconnects mid-answer, the transcript is in MongoDB.

---

## 3. Technical Decisions & Tradeoffs

| Decision | Why |
|---|---|
| **Streaming chunks over a single end-of-interview upload** | If a candidate drops at minute 19 of 20, we still have 19 minutes of usable video. Also avoids a multi-hundred-MB blob blocking the UI thread when stopping `MediaRecorder`. |
| **Separating Voice Agent audio from MediaRecorder** | They serve different masters. Voice Agent gives us a *live* transcript + bidirectional speech; MediaRecorder gives us a *recording* for recruiter playback. Trying to do both with the same audio path means choosing between "transcript quality" and "recording quality" — we get both. |
| **Backend WS proxy for Deepgram** | The DEEPGRAM_API_KEY never reaches the browser. The proxy also gives us a free instrumentation point — every transcript is logged + persisted server-side. |
| **Deterministic chunk keys (`chunk_NNN`)** | Lets FFmpeg concat using a simple sorted listing even if chunks arrived out-of-order or are re-uploaded after retry. Zero-padding to 3 digits makes lexicographic sort = numeric sort. |
| **BullMQ + Upstash Redis** | Decouples request latency from FFmpeg/Groq latency. Upstash gives us a managed Redis with TLS that BullMQ supports natively. Multiple worker replicas can be added horizontally. |
| **Atomic lock on `completed` transition** | A `findOneAndUpdate({ isLocked: false }, {$set: {isLocked: true, ...}})` guarantees we never enqueue the worker twice if the client retries the status POST. |
| **Per-question Groq during interview** (vs. only at the end) | Makes the interview feel like a conversation, which dramatically improves candidate experience and engagement. Also amortises Groq cost across the interview rather than spiking at the end. |
| **face-api.js TinyFaceDetector** | Smallest model (~190 KB), runs at 224 input size on CPU at >30 FPS on a modern laptop. Good enough for "is there exactly one face?", which is all proctoring needs. Models served from `/public/models` so we don't depend on an external CDN. |
| **JWT auth (recruiter)** | Simple, stateless, works behind any reverse proxy. Token is stored in `zustand/persist` (localStorage). |

---

## 4. Failure Scenarios & Edge Cases

| Scenario | Mitigation |
|---|---|
| **Network drop during chunk POST** | Client retries the chunk once after 1s. If both fail, the chunk is logged & dropped; the worker continues with the remaining chunks. |
| **Duplicate chunks** (client retried after partial success) | S3 `PutObject` is idempotent on a key; Mongo upsert checks `(questionIndex, chunkIndex)` and overwrites. |
| **Camera/mic disconnected mid-answer** | `MediaStreamTrack.onended` fires → emits `CAMERA_DISCONNECT` / `MIC_DISCONNECT` proctoring event. The MediaRecorder keeps producing the chunks it can; the recruiter sees the disconnect in the flag list. |
| **WebSocket reconnect** | Socket.IO client has built-in exponential reconnect (10 attempts). On reconnect we re-emit `join_session` and emit a synthetic `RECONNECT` event so the recruiter can see the gap. Voice Agent WS is more sensitive; if it drops, the agent stops speaking — the candidate is shown the agent status chip and can continue (chunks still upload and transcript will be reconstructed by the worker if needed). |
| **Empty / corrupted media chunk** | Two-layer guard: client refuses to POST if `blob.size < 100`; server refuses with `204 No Content` if `req.file.size < 100`. During merge, individual unreadable chunks are skipped, not allowed to crash the whole job. |
| **Partial upload failure** (some chunks for Q3 made it, some didn't) | Worker still merges whatever's present. Mongo `session.uploadedChunks` is the source of truth — the worker reads from it, falling back to an S3 `ListObjectsV2` prefix scan if it's empty. |
| **Browser tab killed mid-interview** | Session stays in `in_progress`. The recruiter sees it. If the candidate re-opens the link AND `isLocked === false`, they can resume from `currentQuestionIndex` (this scaffolding is present — resume UI can be added without schema changes). If `isLocked === true` (e.g. they already hit "completed"), they see the locked screen forever. |
| **Deepgram outage** | The agent WS errors → status becomes `error`, candidate sees the chip. Chunks still upload; the worker still produces a video for the recruiter. The recruiter will see no transcript but full video — better than nothing. |

---

## 5. Recovery Mechanisms

- **State persistence.** Every meaningful event is written to MongoDB *before* responding 200. Session document is the central brain.
- **Chunk recovery.** Deterministic keys + Mongo `uploadedChunks` + S3 prefix fallback means the merge step is robust to any ordering / retry pattern.
- **Retry/recovery logic.**
  - Chunk POST: 1 retry on the client.
  - BullMQ job: 5 attempts with exponential backoff (5s base).
  - Worker per-question loop: errors in one question never abort others — we degrade gracefully.
- **Socket reconnection.** Built-in Socket.IO reconnect + synthetic `RECONNECT` proctoring event so the recruiter has a precise timeline.
- **Failure handling.**
  - If the BullMQ job exhausts all attempts → session status moves to `failed` so the recruiter sees it.
  - Mongo writes use `$set` with `findOneAndUpdate` for the locking critical section; no read-modify-write race.
  - Worker uses temp directories per-question and `fs.rm(..., {recursive: true, force: true})` in `finally` blocks so disk doesn't fill up on partial failure.

---

## 6. Product Thinking

### Recruiter
- **Stats row** at the top of the dashboard so the recruiter can sanity-check at a glance ("did 12 interviews go out, did any fail?").
- **Filter tabs** to triage — almost everyone wants to see `done` first, then `failed`, then everything else.
- **Per-question card** with video + transcript + score side-by-side so the recruiter can spot-check questions they care about without scrubbing through a 20-minute monolith.
- **Pre-signed URLs** (1h TTL) so we don't leak our S3 bucket but the recruiter doesn't need separate credentials.
- **Live polling while `processing`** so the recruiter can open the link immediately after the candidate finishes and watch results stream in.

### Candidate
- **Mandatory hardware check** with live face detection — catches the "I forgot to plug in my webcam" / "my flatmate is in the room" cases before time pressure kicks in.
- **Real conversation feel** — the agent speaks the question, listens, then speaks honest feedback. Far less alienating than a webcam interview with no other human (or AI).
- **Silence detection** — candidate doesn't have to find a "next" button when they're done; they just stop talking for 4 seconds and the interview advances.
- **Progress bar** at the bottom so they always know how much is left.
- **Persistent lock** so the link can't be re-attempted — a clear signal that the recording is final.

### Suspicious activity tracking
All proctoring events go through `Socket.IO` to a single sink (`ProctoringEvent` collection). The collection is **append-only** — we never edit or delete an event. Recruiter dashboard groups them by session and shows them in a timeline against question index. Categories tracked: tab switch, window blur, face absent (>3s), multiple faces, fullscreen exit, copy/paste, camera/mic disconnect, socket reconnect.

### UX decisions
- **Dark mode + Sora font + a single accent color (#3b82f6).** Looks calm, doesn't fatigue the eye over a 20-min interview.
- **Transcript shown live during the answer phase** — candidates can self-correct if they realise the system misheard a critical word.
- **Voice Agent status chip always visible** — if something is wrong with the AI, the candidate knows immediately rather than wondering why it stopped responding.
- **Locked screen wording is reassuring**, not punitive ("This interview is closed" + "contact your recruiter if you think this is a mistake").

---

## 7. Scalability Considerations

### What may break at scale
- **WebSocket fan-in on the API.** Each candidate keeps a Voice Agent WS open + a Socket.IO connection. At ~5k concurrent candidates per Node process, the event loop starts to drown.
- **S3 chunk PUT throughput.** Default S3 limits are generous, but if you have hundreds of candidates all uploading 5s chunks every 5s, you can hit per-prefix request rate limits if all chunks share a prefix. Our keys are `${sessionId}/...` so per-prefix fanout is natural.
- **FFmpeg memory.** The worker buffers the merged file into RAM before `putObject`. For long interviews (>30 min) we should stream the merged output directly to S3 via `lib-storage` `Upload`.
- **Mongo write contention on the session document.** Every chunk POST and every Voice Agent transcript chunk does a write. The chunk list grows unbounded.

### Performance bottlenecks
- The Voice Agent **playback path** is the most CPU-intensive thing in the browser (decoding 24k PCM frames). On low-end laptops this can cause MediaRecorder hiccups.
- The Voice Agent **upstream WS proxy** in the server is currently piping all frames through a single Node process. A binary fast path (no JSON parsing) would help.

### Future improvements for high concurrency
- Move the Voice Agent proxy onto its own Node service so REST traffic and WS traffic don't share an event loop.
- Run multiple BullMQ worker pods; the queue already supports this.
- Switch chunk uploads to **direct-to-S3 with pre-signed POST** so the API server is removed from the data path entirely. The server only records the chunk metadata.
- Move proctoring events to a write-optimised store (e.g. Timescale / Mongo time-series collection) — they grow fast.
- CDN-cache the static client (Vite build → Cloudfront / Cloudflare).
- Use Mongo `$push` with a `$slice` cap for `uploadedChunks` and overflow into a separate collection for very long interviews.

---

## 8. Observability & Debugging

### Logging strategy
- **Winston** logger, configured in `server/utils/logger.js`. Dev = colorized console; prod = JSON one-line-per-event for shipping into CloudWatch / Datadog / Loki.
- **Every request** has a `requestId` (UUID, honors incoming `x-request-id`). It's set as a response header and included in every log line for that request via a child logger.
- **Every meaningful domain event** is logged with structured metadata:
  - `chunk_uploaded`: sessionId, questionIndex, chunkIndex, size, s3Key
  - `proctoring_event`: sessionId, type, questionIndex
  - `voice_agent_*`: client_connected, upstream_open, transcript_received, upstream_close, etc.
  - `worker_job_started` / `ffmpeg_complete` / `groq_per_question_complete` / `worker_job_done` / `worker_job_failed`
  - `session_created` / `session_status_changed` / `session_locked`
  - `auth_login` / `auth_register` / `auth_invalid_token`
- HTTP access middleware (`middleware/logger.js`) logs `method, path, status, durationMs` per request.

### Error tracking
- Unhandled errors hit a single Express error middleware which logs with stack trace and returns a sanitised JSON body (`message` is suppressed in prod).
- `process.on('unhandledRejection')` and `uncaughtException` both forward to the logger so nothing dies silently.
- BullMQ failed jobs emit `worker_job_failed` with `jobId` and `failedReason`.

### Debugging production failures
1. Filter logs by `sessionId` — every event for that interview is tagged with it.
2. Filter logs by `requestId` for a single REST call.
3. Failed BullMQ jobs are kept (`removeOnFail: 1000`) so you can inspect them via BullMQ's admin tools or by re-running the worker on the failed jobs.
4. Pre-signed URLs for failed sessions still work; you can manually inspect chunks in S3 at `${sessionId}/${questionIndex}/`.
5. Mongo's session document is the central brain — `db.interviewsessions.findOne({token: "..."})` shows you status, chunks, answers, transcripts, lock state.

---

## 9. AI Usage Documentation

This codebase was built with heavy AI assistance — here's the honest breakdown.

### Tools used
- **Claude** for the overall architecture discussion (Voice Agent proxy, the audio worklet, the phase machine in `InterviewPage`).
- Documentation lookups for the **Deepgram Voice Agent** WS protocol and **BullMQ + Upstash** TLS quirks.
- Generate the approach
- **Claude Sonnet, llama** for the scaffolding, debug logs and tell the exact causes to every bug.

### Prompts / thought process
- We started with a tight, opinionated spec (the one in this README + the original task brief). The AI was given the full spec up front so it could make consistent decisions across modules rather than re-deciding architectures per file.
- For each module the AI was asked to: (a) follow the spec literally, (b) leave inline `// ...` comments only where a future maintainer would need them, (c) preserve the same names / paths the spec mentions.
- The riskiest part — the Voice Agent message protocol — was written defensively: the hook accepts *several* variants of transcript / speech-state messages, because Deepgram's Voice Agent shapes have shifted across API revisions.

### What was AI-assisted vs. our decision
- **Our decisions:** the schema, the deterministic chunk-key convention, the "lock + enqueue atomically" pattern, the choice to do per-question Groq during the interview (not after), the choice to keep MediaRecorder separate from Voice Agent audio capture, prompt architecture, exact workflow.
- **AI-assisted:** boilerplate (routes, Mongoose schemas, MUI dialog forms), the audio worklet for PCM downsampling, the dual-channel playback approach in the Voice Agent hook, the ScoreRing SVG component, README structuring.

---

## 10. Setup

### Prerequisites
- Node 18+
- MongoDB Atlas cluster (or local mongo)
- Upstash Redis (or local redis)
- AWS S3 bucket in `ap-south-1`
- Deepgram API key (Voice Agent enabled)
- Groq API key
- `ffmpeg` installed on the worker host (`brew install ffmpeg` / `apt install ffmpeg`)

### Backend

```bash
cd server
cp .env.example .env       # fill in values
npm install
npm run dev                # api server on :5000
# in a separate terminal:
npm run worker:dev         # BullMQ worker
```

### Frontend

```bash
cd client
cp .env.example .env
npm install

# face-api.js model weights (one-time):
cd public/models
BASE=https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights
curl -sLO "$BASE/tiny_face_detector_model-weights_manifest.json"
curl -sLO "$BASE/tiny_face_detector_model-shard1"
cd ../..

npm run dev                # vite dev server on :5173
```

Open `http://localhost:5173/recruiter/login`, create an account, create a template, create an interview link, open the link in another browser, complete the interview, watch it process.

### Demo video / live link

- [Demo Video](https://drive.google.com/file/d/1kihRKc4v7Y-hckRVDgmpgcRtm9yJhmQg/view?usp=sharing)
- https://intervi-ai.vercel.app/

### System walkthrough
- **Recruiter creates template + interview** → dashboard shows the row in `pending`.
- **Candidate opens link** → hardware check → enters name → "I'm ready" → InterviewPage.
- **Voice Agent connects, speaks Q1** → thinking timer → recording starts → candidate answers → silence detected → "Reviewing..." → agent speaks Groq feedback → next question.
- **After last question** → agent speaks goodbye → POST status:completed → session is locked + worker enqueued → candidate sees Thank You page → /interview/:token is locked forever.
- **Recruiter dashboard** auto-refreshes → status moves `completed → processing → done` → recruiter opens the detail page and sees per-question merged videos + transcripts + AI scores + proctoring flags.

---

## Folder layout

```
ai-interview/
├── server/
│   ├── index.js                  # Express + Socket.IO + WS upgrade
│   ├── config/{db,queue}.js
│   ├── models/index.js
│   ├── routes/
│   │   ├── auth.js               # /api/auth/*
│   │   ├── sessions.js           # /api/sessions/* (candidate)
│   │   ├── chunks.js             # /api/chunks/:token
│   │   ├── recruiter.js          # /api/recruiter/* (JWT)
│   │   └── voiceAgent.js         # WS proxy /api/voice-agent/:token
│   ├── middleware/{auth,logger,requestId}.js
│   ├── utils/{s3,logger}.js
│   ├── workers/processor.js      # BullMQ worker (FFmpeg + Groq)
│   └── .env.example
└── client/
    ├── public/models/            # face-api.js weights live here
    └── src/
        ├── pages/{HardwareCheck,InterviewPage,InterviewComplete,InterviewLocked,RecruiterLogin,RecruiterDashboard,SessionDetail}.jsx
        ├── hooks/{useMediaRecorder,useProctoring,useFaceDetection,useVoiceAgent}.js
        ├── store/authStore.js
        ├── utils/api.js
        ├── components/shared/ProtectedRoute.jsx
        ├── theme.js
        ├── main.jsx
        └── index.css
```
