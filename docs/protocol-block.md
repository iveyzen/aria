# Work block: response protocol model + truncate

Agreed with external review 2026-07-31 (baseline commit `4a0fd95`). This is the next major
work block; persona text is frozen until the replay evaluation exists.

## Acceptance criteria (from review, verbatim intent)

- Every response carries `response_id + kind + requestId + sessionGeneration`.
- No global `pendingJudge` flag and no global transcript buffer remain.
- Cancels target an exact response id.
- Transcripts aggregate per response/item.
- The renderer reports actual playback progress (ms) back to main.
- Barge-in performs BOTH the local buffer clear and server-side `conversation.item.truncate`
  at the ms the user actually heard — today her server context keeps speech nobody heard.
- Logs distinguish `generated / played / interrupted / discarded` for every spoken line.
- An async tool result from an old session can never be delivered into a new session
  (sessionGeneration guard).
- proactive / initiative / probe can run concurrently and can never consume each other's
  results.
- Replay can reproduce the "she said it but the user never heard it" scenario.

## Single-hop out-of-band candidate (experiment, NOT a replacement yet)

Out-of-band (`conversation: "none"`) audio response as initiative candidate: buffer audio,
read the transcript head, `PASS` → cancel by id and discard; otherwise release the buffered
audio and insert the actually-heard transcript into the main conversation as an assistant item.

Hard requirement — **context parity**: the experiment must record a `ContextManifest`
(exact recent turns, screenshot item ids, STM tail, callback candidates) and guarantee the
candidate path and the main-conversation path see the same manifest; A/B on the same replay
batch. Otherwise the comparison measures context differences, not architecture. Fallback
design if first-audio latency disappoints: out-of-band text judgment → dedicated TTS reading
the exact line (still better than a second Realtime inference paraphrasing it).

## Activity classification (for pacing instrumentation)

Deterministic rules only: window process, title matches, transcription keywords. Store
`{activity, evidence, ruleVersion}`; unknown stays `unknown: 1.0x` — never force a class.
A model may later act only as a tiebreaker when rules abstain. Scene multipliers (initial):
game/stream 0.8x · social browsing 1.0x · long reading 1.8x · coding/writing 2.5x ·
explicit "less" → quiet, and no policy may raise a level the user set.

## Instrumentation per initiative (start recording NOW, learn later)

`{initiativeId, activity, evidence, reason, playedAt, userReplyMs, interrupted,
explicitMoreOrLess, unansweredCount}` — adaptive pacing waits until enough sessions exist,
then Beta/Bayesian with priors and sample floors, scaling only within the user-chosen preset.
