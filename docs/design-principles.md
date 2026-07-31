# Design principles (external review, round 3 — 2026-07-31)

> The model gets judgment; the deterministic system keeps power, boundaries, and durable state.

## 1. Presence: event-driven sentinel, never a free-running inner monologue

Event stream → cheap **impulse generator** (called on meaningful events, NOT continuously) →
structured `Impulse {id, topic, evidenceIds, urgency, expiresAt, interruptibility, proposedAct}`
→ deterministic **policy gate** (activity, privacy, preset, backoff, budget, dedupe, expiry,
user-speaking) → Realtime expression.

Session lifecycle: **hot** (Realtime connected) / **warm** (disconnected; local VAD + frame diff
+ OCR keep watching) / **cold** (low-frequency activity detection, wake ability only). Wake
injects a `HandoffCapsule {lastTurns, lastHeardAt, lastSpokenAt, currentActivity,
currentScreenSummary, selectedMemories, pendingImpulses}` — "she's always there" comes from
waking without amnesia, not from an open socket. Cold end needs LOCAL VAD/hotword + a few
seconds of ring-buffered audio (cloud always-on transcription ≈ $122/mo at 4h/day — just a
different bill). Cost note: Realtime bills tokens (audio/text/image), not idle socket minutes.

## 2. Memory: visible, correctable, and deletions must hold

Panel per fact: what, source (user-stated / inferred / seen-on-screen), first/last seen,
used-in-callback, edit/forget/never-remember. Voice tools: `forget_fact`, `correct_fact`,
`never_remember_topic`. Deletion writes a **tombstone** — otherwise the next distill batch
resurrects the fact from old STM or screen evidence. Defaults: user-stated preferences persist
automatically; inferences are low-confidence and visible; screen-derived personal facts do NOT
enter LTM; finance/health/private-chat/identity never auto-persist; secrets are masked before
any model sees them. Trust = "she can't silently form an uncorrectable me."

## 3. Self-knowledge: AI identity embraced, self-model provenance locked

She may know she's an AI, sees screens, forgets, mishears, was asked to talk less, got updated.
She may NOT learn her own definition from the screen (persona diffs in a terminal are
`untrusted_observation`, not autobiography — else any webpage becomes persistent prompt
injection). Trusted `SelfModel {identity, capabilities, limitations, userAdjustedPreferences,
productVersionNotes}` mutated only by code, config, and things the user explicitly tells her.

## 4. Failure honesty: translate mechanisms, never falsify facts

She may humanize errors ("刚那句没听清") but may not fabricate cognition (invent what she
heard, fake-recognize a person, force-fit another game's mechanics, claim a search/memory/
connection succeeded when it didn't). Three-question test — must be honest if hiding would
(1) mislead about her capabilities, (2) make the user believe an action completed, or
(3) feed a decision that matters.

## 5. Relationship: design the mechanics, never pre-write the plot

`RelationshipState {familiarity, teasingPermission, callbackTrust, preferredTone, boundaries,
openLoops, sharedReferences}` — derived from evidence, not elapsed days. Teasing permission is
EARNED (accepted/returned banter ↑, silence decays slowly, explicit dislike ↓ immediately,
sensitive topics never unlock via familiarity). Inside jokes have a lifecycle:
candidate → active (only after natural reuse or user adoption) → stale → retired. The model
receives a compact permission summary ("light game teasing OK; never joke about money;
'上分大业' is an established joke, last used 12d ago"), not a day counter.

## Single-hop candidate experiment — required metrics

Not just latency: line fidelity (vs judged text), language consistency, PASS accuracy,
time-to-first-audible, cost per maybe-speak, and post-interruption context consistency.
ContextManifest parity between candidate and main paths remains a hard requirement.
