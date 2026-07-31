# Tuning Aria

A loop for making Aria sound less like an AI and more like a person.

The idea: feed her scripted situations — a screenshot plus what the user says — capture what she
actually replies, have a second model grade it purely on *"would a real person have said this?"*,
then change `src/main/persona.ts` and measure whether the number moved.

The harness imports `ARIA_INSTRUCTIONS` from `src/main/persona.ts` directly. There is no second copy
of the persona: you are always testing the Aria that ships.

## Run it

```bash
npm run eval:mockups             # once, to generate the screenshots the scenarios reference
npm run eval                     # every scenario, graded, writes a report
npm run eval -- --repeat 3       # 3 passes each — use this before trusting any comparison
npm run eval -- --only boss-entrance,deep-in-work
npm run eval -- --no-judge       # just see what she says, no grading (cheap)
```

Reports land in `eval/runs/`. `latest.md` is the one to read; `latest.json` is the raw data.

The API key comes from `OPENAI_API_KEY`, or from the desktop app's saved config if you've run it once.

**One pass per scenario is noisy.** Whether she chooses to speak or stay quiet is a coin flip on
some scenarios, and a single run swings ±1.0 easily. Always `--repeat 3` before concluding an edit
helped.

## The loop

1. `npm run eval -- --repeat 3` and keep the JSON as your baseline.
2. Read `latest.md`. Two sections matter:
   - **What still sounds like AI** — tells tallied by frequency. This is your to-do list.
   - **Worst lines** — each with *why* it failed and how a person would have said it. The rewrite is
     usually the fastest route to the persona edit you need.
3. Edit `src/main/persona.ts`.
4. Re-run, then diff:
   ```bash
   npm run eval -- --compare eval/runs/<baseline>.json eval/runs/latest.json
   ```
   Regressions are listed first — that's what your edit broke.

Every report records a `personaHash` so you can tell which version of the persona produced it.

## Scenario modes

Each mode drives the same code path the real app uses, so a fix here is a fix in production.

| Mode | What it exercises | Can she stay silent? |
| --- | --- | --- |
| `chat` | She was addressed directly | No — she always answers |
| `proactive` | Screen changed a lot (`PROACTIVE_PROMPT`) | No |
| `initiative` | It's been quiet; speak up? (`INITIATIVE_PROMPT`) | Yes, but rarely should |

Picking the right mode matters. A "she should have stayed quiet" scenario written as `chat` forces
her to talk and will always score badly — the failure is in the test, not in her.

## Adding a scenario

Drop an object into any JSON file in `eval/scenarios/`:

```json
{
  "id": "unique-slug",
  "title": "Short human-readable name",
  "mode": "chat",
  "screen": "screens/whatever.png",
  "screenNote": "What's on screen, in words.",
  "memory": "- optional long-term memory to inject",
  "turns": ["what the user says", "and then this"],
  "expect": "What a good reply looks like — and what would count as a failure."
}
```

`expect` is given to the grader, so write it as instructions to a judge, including the failure modes
you care about. It's the highest-leverage field.

## Screenshots

Every shipped scenario references an image. The images are generated, not committed, so **run this
once before your first eval** (and any time you add a scenario):

```bash
npm run eval:mockups
```

They live in `src/eval/mockups.ts` as HTML, so edit that file to add or change one. Mockups are used
instead of real desktop captures so the committed corpus contains nobody's private screen.

To swap in a real screenshot — better signal, since it's the actual thing she'll see:

```bash
npm run eval:capture -- --list                          # see available screens/windows
npm run eval:capture -- boss-entrance --delay 5         # 5s to set up the shot
npm run eval:capture -- my-shot --match "Elden Ring"    # capture a specific window
```

Then add `"screen": "screens/boss-entrance.png"` to that scenario. Both the model and the grader see
the image.

If a scenario names a `screen` file that isn't there, it still runs — text-only — but is marked
**degraded** in the report. Don't read a degraded run as evidence about her vision.

`eval/screens/` and `eval/runs/` are gitignored; screenshots of your own desktop stay local.

## Cost

Text-only Realtime plus one grader call per line. A full `--repeat 3` pass over the shipped set is
roughly 48 graded lines and costs well under a dollar. `--no-judge` roughly halves it.
