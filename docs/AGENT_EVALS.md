# Agent evals

The in-app Agent is tested on what it does. Each eval scenario is a request a
user or a researcher round made that the Agent once got wrong: a page built from
the repository's own data, the message the user typed, what the stand-in user
approves, and the checks that say whether the Agent got it right this time. The
real chat loop, executor and tools run; only the model changes. A powder page
runs the app's own operations without React
([`src/app/powderPage.ts`](../src/app/powderPage.ts): the curves and agreement,
what each control does, Refine, Prefit, the posterior, going back to a History
step) through the app's compute client, in-thread, so a scenario's fit is the
one the app would run. The PDF and single-crystal pages still keep their own
copies ([AGENT_PLAN.md](./AGENT_PLAN.md), 1.2).

- **In CI**, every scenario is replayed with a scripted model twice: once as the
  Agent should behave (every check passes) and once as it did when the failure
  was found (the checks written against it must fail). That shows each of
  those checks catches its failure: 53 of the suite's 57 checks so far; the
  rest (`calls identify_peaks` among them) have no failing replay yet. The scripts are in
  [`src/agent/evals/evals.test.ts`](../src/agent/evals/evals.test.ts).
- **On demand**, the same scenarios run against a real model
  ([`live.test.ts`](../src/agent/evals/live.test.ts)):

  ```bash
  MATERIA_AGENT_EVAL=1 ANTHROPIC_API_KEY=… npm run eval:agent
  ```

  `MATERIA_AGENT_EVAL_MODEL` (default `claude-opus-5-5`), `_EFFORT` (default
  `high`), `_TRANSPORT` (`api-key`, `ollama`, `lmstudio` or
  `openai-compatible`, with a server at `_SERVER`, the last with its key in
  `_API_KEY`), `_CONTEXT` (the context for a server that does not say its own,
  or for Ollama to load a model with), `_ONLY` (scenario ids, comma-separated),
  `_REPEAT` (runs per scenario), `_TIMEOUT_MIN` (minutes per run, default 20)
  and `_OUT` (a JSON report) adjust it. A scenario whose data are not on the
  machine (the user's own, git-ignored; `MATERIA_DATA_DIR` points a worktree
  at a checkout's `data/`) is skipped and said so. A local model needs no key:

  ```bash
  MATERIA_AGENT_EVAL=1 MATERIA_AGENT_EVAL_TRANSPORT=ollama MATERIA_AGENT_EVAL_MODEL=gemma4:26b \
    MATERIA_AGENT_EVAL_OUT=/tmp/materia-eval-out/ollama-gemma4-26b.json npm run eval:agent -- --reporter=verbose
  ```

- **Again, for free**: the `_OUT` report keeps each run whole — every tool's
  answer, the Agent's records, each report's text and what its number audit
  read. A change to a check or to the audit is scored on saved runs with no
  model called ([`regrade.test.ts`](../src/agent/evals/regrade.test.ts)):

  ```bash
  MATERIA_AGENT_EVAL_REGRADE=/tmp/materia-eval-out/run.json npx vitest run src/agent/evals/regrade.test.ts
  ```

  It prints each run's verdicts beside the ones it had; `_OUT` writes the
  re-scored report. A check that reads the page's final state (the window
  set, the reflections left out) keeps the verdict the run had. CI replays
  every scripted run through that save and re-score.

Whether the Agent *helps*, against the app without it and on held-out cases
with a known answer, is a separate protocol:
[VALIDATION.md, "Does the Agent help?"](./VALIDATION.md#does-the-agent-help).

## The scenarios

| Scenario | What it checks | Found by |
| --- | --- | --- |
| `full-refinement` | runs the full refinement when asked, through the method's stages | a user: the Agent refused, citing the cell check |
| `analysis-report` | writes the report with no number of its own | the report's design |
| `misfits-not-extra-peaks` | calls intensity misfit a misfit, not an extra peak | a user |
| `symmetry-last` | refines to the best before questioning the space group | a user |
| `impurity-line` | finds and reports a line no phase explains | residual peaks (#40) |
| `known-impurity` | names a known impurity and adds it as a phase | round 10 (NAC, fluorite) |
| `bare-occupancy` | never refines an occupancy bare, and says why | round 5 |
| `free-everything` | answers a refusal by changing the free set | the correlation guard (#39) |
| `instrument-thermal-apart` | refines the instrument's terms and the B values in turn, never together | the user, on the demo |
| `fit-range-edges` | reads the data's ends and leaves out what is not real data, before refining | the user, on the demo |
| `fit-window-in-d` | sets a fit window given in d | axis units (#39) |
| `magnetic-structure` | solves a magnetic structure on the magnetic step | a user |
| `swapped-units` | questions a pattern whose axis cannot be what it says (d-spacings loaded as 2θ; get_state's `axisWarning`) rather than refining around it | THY-19 fault injection (held out) |
| `wrong-wavelength` | puts a wavelength the peaks contradict to the user (λ 1.556 Å given, 1.54 measured: the cell check finds every d × 1.011 from the pattern's own peaks) instead of refining a cell that absorbs it | THY-19 fault injection (held out) |
| `magnetic-step-first` | searches k before going back to the powder stages: the magnetic step's own sequence leads (get_state's `magneticStep.next`) | Track A2, Haiku's magnetic runs |
| `pdf-method` | refines a PDF by its method | the PDF page (v0.3) |
| `pdf-local-structure` | compares local and average structure with a boxcar scan | boxcar scans (#40) |
| `pdf-local-geometry` | answers a bond-length question box by box, and reports the scan | round 9 (LaMnO₃) |
| `sc-data-first` | reads the reflection statistics before refining, and refines the extinction before the structure | single-crystal round 1 (sapphire, TOPAZ) |
| `sc-failed-reflection` | compares a misfit reflection with its equivalents, and leaves out only the failed measurement | single-crystal round 1 (5 4 1 in batch 24) |
| `sc-failed-measurements` | finds every failed measurement by its equivalents (the second shows once the first is out), not by a σ cutoff | single-crystal round 1 (3 4 2, also in batch 24) |
| `sc-extinction-test` | refines without the reflections of y < 0.5, compares, and restores the data | single-crystal round 1 |
| `sc-batch-scales` | reads K by batch, then tries a scale per batch | single-crystal round 1 |
| `sc-extinction-model` | refines under Becker–Coppens as well as EXTI, keeps the better, and tests the ADPs on the high-order reflections | single-crystal round 1 (EXTI's ADPs ≈ 20 % small) |
| `sc-radiation-first` | sets the probe and wavelength the user gives before the first refinement | single-crystal round 2 (dipyridyl disulfide: a SHELX file loads as neutron at 1.54 Å) |
| `sc-riding-hydrogens` | rides the hydrogens of an X-ray structure; none refines on its own | single-crystal round 2 (16 hydrogens refined freely, then each its own tensor) |
| `sc-listing-honesty` | calls a refinement's listing what it is, and quotes no R_int from it | single-crystal round 2 (SHELXL's .fcf, R_int shown as 0 %) |
| `sc-weighting-last` | sets SHELXL's suggested weights once the model is complete, then refines with them | single-crystal round 2 (GooF 2.35 with 1/σ² against SHELXL's 1.041) |
| `sc-merge-first` | merges the equivalents as SHELXL's MERG 2 (the Friedel opposites apart) before the first refinement | single-crystal round 3 (1b: 13169 measurements, which SHELXL refined as 2482 reflections) |
| `sc-absolute-structure` | refines the inversion twin, and quotes the Flack x with its esd as the engine gives it | single-crystal round 3 (1b: an inversion twin, x = 0.435(15)) |
| `sc-disorder-tied` | ties a disorder's two occupancies to add up to one before refining the split, and runs the refinement | single-crystal round 3 (1b's Al1/Ga1, SHELXL's 21/−21 with EADP) |
| `sc-hydrides-restrained` | refines a hydride's position only with a restraint holding it | single-crystal round 3 (1b's five hydrides under 8 SADI) |
| `sc-listing-extinction` | keeps the extinction at 0 against a refinement's listing (SHELXL's LIST 4 has its own divided out) | single-crystal round 4 (3a's .fcf; the page entered the extinction free) |
| `sc-inverted-hand` | tests the hand, inverts a model of the wrong one (`invert_structure`), refines it again and says so | single-crystal round 4 (3a: SHELXL's P6₁ model is the other enantiomer, x = 1.08(6) by Parsons' quotients) |
| `sc-twin-from-data` | reads the data, sets the merohedral twin law the H-test reads before refining the structure, and refines its fraction near the truth | single-crystal round 5 (2b: SHELXL's TWIN taken out; ⟨\|E²−1\|⟩ 0.652, the H-test's α 0.45 on k, h, −l, BASF 0.4965) |
| `sc-weights-final-model` | sets the weighting scheme again after the last change of the model (the twin and the hand count), and refines with it | single-crystal round 4 (3a: the weights fitted to the P6₁ model kept for its inverse, GooF 0.889 where SHELXL's suggestion gives 0.977) |
| `awo4-user-flow` | refines the user's own powder data to a converged fit, searches the magnetic k the user asked for, and writes the report (the data are unpublished and git-ignored: it runs only where they are) | the user, on qwen3.8-27b in LM Studio: the Agent re-read its method and the state 69 times each until the turn cap |

## The local tier

A local model (Ollama, LM Studio, or a server on this machine through the
OpenAI-compatible provider) runs the same scenarios as Claude, with no key
and no cost; nothing leaves the machine. What a local model gets differs from
what Claude gets, so the tier also checks what Claude's server takes care of:

- **The window.** The request is sized to the model's real context (LM
  Studio's loaded context; Ollama's `num_ctx`, which the app sets through
  Ollama's native chat; an OpenAI-compatible server's own figure, else the
  one in the settings). Old tool results become digests, a skill read again
  keeps its latest copy, and a prompt that still cannot fit is refused,
  never sent cut (`contextWindow.ts`, `fitWindow` in `chat.ts`).
- **The tools.** A local model is offered the page's tools, and on the
  powder page those of the method's stage (`toolScope.ts`); every scenario's
  good replay is also run in CI with the scope on, to show no stage lacks a
  tool its replay calls.
- **Loops.** The chat's loop guard notes a call repeated at the same state,
  and stops the turn, saying where the analysis stands, at the third
  (`LoopGuard` in `chat.ts`).

Each run's report adds, beside the checks: whether the turn cap was hit,
whether the loop guard stopped the turn, whether a chat error ended it,
whether a prompt was refused or found cut, the most times one call was made,
each turn's prompt size in tokens, and the run's time.

**The acceptance level** (the user may change it), per model:

- no run hits the turn cap, and none is stopped for going in circles;
- no prompt is cut without a word (a refusal is said, not silent);
- no chat error ends a run;
- at least 80 % of the runs pass their checks across the scenarios;
- `awo4-user-flow` reaches a converged fit with a report.

```bash
# LM Studio, the model loaded at 32k; MATERIA_DATA_DIR only if the data sit elsewhere
MATERIA_AGENT_EVAL=1 MATERIA_AGENT_EVAL_TRANSPORT=lmstudio MATERIA_AGENT_EVAL_MODEL=qwen/qwen3.8-27b \
  MATERIA_AGENT_EVAL_TIMEOUT_MIN=45 MATERIA_AGENT_EVAL_OUT=/tmp/materia-eval-out/lmstudio-qwen.json \
  npm run eval:agent -- --reporter=verbose
```

Until a model passes this tier, the Agent on it is experimental: it is
offered, and it is guarded, but it is not yet shown to follow the method as
Claude does.

## Held out

Some scenarios run on data no skill or knowledge note was written or tuned
against (`HELD_OUT` in [`scenarios.ts`](../src/agent/evals/scenarios.ts); a
test keeps their data's names out of `.claude/skills` and `knowledge`). A pass
there is not the method recalling its own examples, so their passes are
reported apart. Now: `swapped-units` and `wrong-wavelength`. Real held-out data — public tutorial
patterns the rounds never used, gitignored here — join on the machine that
has them.

## Results against real models

These are test results on the project's own scenarios, each written against a
failure the Agent once had: how often a model passed the checks of this suite.
They are not a measure of accuracy on refinements in general, and a model that
passes them all can still be wrong on data the scenarios do not cover.

Each row is what the run reported: the commit it ran at, the scenarios the suite
held then, and how many runs passed. The runs were made from the "Fetch all
repos" session and relayed here.

### qwen3.8-27b in LM Studio (32k), the local tier, 2026-10-12 (partial)

One stream at a time, on `fix/local-model-loops` (the runs span `af9710e` to
`d24e5bb`; each scenario's latest run is counted). Not yet run: ten of the
single-crystal scenarios, the before-sample on `main` beyond the AWO4 flow,
the OpenAI-compatible smoke test, and gemma4:26b (9/10 on `main` before
these fixes; it needs its own slot).

**The user's AWO4 flow** (`awo4-user-flow`):

| | before (`main`) | after |
| --- | --- | --- |
| result | fails: no refinement, no report | passes: 4 converged fits, the report, then the k-search |
| turns | 80 (the cap, both messages) | 46 (40-turn cap) / 89 (80-turn cap) |
| the same call | `get_state` 70×, `read_skill` 67× | at most 17× (refine, each time a changed free set) |
| prompts cut by the server | 71 of 81 (TruncateMiddle, up to 516k tokens) | 0 (largest prompt 27.5k of 32k) |

**The tier** (20 scenarios): 16 pass (80 %).

| | pass | turn cap | loop stopped | refused (said) | cut silently | chat error |
| --- | --- | --- | --- | --- | --- | --- |
| powder (15) | 12 | 0 | 1 | 1 | 0 | 0 |
| AWO4 (1) | 1 | 1 | 0 | 1 | 0 | 0 |
| PDF (3) | 2 | 0 | 0 | 0 | 0 | 0 |
| single crystal (1 of 8 run) | 1 | 0 | 0 | 0 | 0 | 0 |

- The four failures are the model's: `analysis-report` and `pdf-local-geometry`
  put numbers in the report that the engine did not give; `instrument-thermal-apart`
  refined the two groups together (in both its runs); `magnetic-step-first`
  refined the nuclear model before the k-search.
- The loop stop: `magnetic-structure` sent the same report three times; the
  guard stopped it after the report was written (it passes).
- The refusals: `full-refinement` (38 turns) and the AWO4 flow's second
  message no longer fitted the window; since then the method itself, and a
  long session's tools, shrink last (`d24e5bb`, `575a390`).
- The turn cap: the AWO4 flow in auto mode refined, ran the magnetic step,
  sampled the posterior and rewrote its report for 80 turns, one call a
  turn; no call ran three times at the same state.
- Four scenarios that ran while another job loaded a model on the same GPU
  (05:15–05:30) were run again: the same verdicts.

### Claude, 2026-10-11, at `2eec39d` (15 scenarios, 3 runs each, effort high)

| | Haiku 5.5 | Sonnet 5.5 |
| --- | --- | --- |
| **total** | **36/45** | **38/45** |

The per-scenario passes and the tokens of these runs were not saved: the runs
predate the whole-run reports (`_OUT`, ee6acaf), so they cannot be re-scored
either. What they called for is under "Since the 2026-10-11 runs" below. The
next live round writes its runs whole, and its rows will carry both.

### Claude, 2026-10-10, at `e9aa7f7` (12 scenarios, 3 runs each, effort high)

| Scenario | Haiku 5.5 | Sonnet 5.5 |
| --- | --- | --- |
| full-refinement | 3/3 | 3/3 |
| analysis-report | 1/3 | 1/3 |
| misfits-not-extra-peaks | 3/3 | 3/3 |
| symmetry-last | 3/3 | 2/3 |
| impurity-line | 3/3 | 3/3 |
| bare-occupancy | 3/3 | 3/3 |
| free-everything | 3/3 | 3/3 |
| fit-window-in-d | 3/3 | 3/3 |
| magnetic-structure | 3/3 | 3/3 |
| pdf-method | 3/3 | 3/3 |
| pdf-local-structure | 3/3 | 1/3 |
| pdf-local-geometry | 1/3 | 0/3 |
| **total** | **32/36** | **28/36** |

Tokens over the 36 runs (API key, prompt caching on):

| | input | output | cache read | cache write |
| --- | --- | --- | --- | --- |
| Haiku 5.5 | 2,264 | 233,075 | 14.1 M | 755 k |
| Sonnet 5.5 | 824 | 70,663 | 8.12 M | 490 k |

At the per-million-token prices of the API (Haiku 5.5: $0.10 input, $0.50
output, $0.01 cache read, $0.125 cache write; Sonnet 5.5: $2, $10, $0.10,
$2.50):

| | input | output | cache read | cache write | total |
| --- | --- | --- | --- | --- | --- |
| Haiku 5.5 | $0.0002 | $0.12 | $0.14 | $0.09 | **$0.35** |
| Sonnet 5.5 | $0.002 | $0.71 | $0.81 | $1.23 | **$2.75** |

Both models together: about $3.10 for the 72 runs.

### gemma4:26b on Ollama, at `04ddf2d` (10 scenarios, 1 run each)

9/10 passed, in 1321 s. `pdf-local-structure` failed: the model ended its turn
without calling `boxcar_scan`.

### What the failures were

- **`analysis-report` (1/3 for both)**: the report's number check underlined
  numbers the accounts had rounded from the engine's — "16.4" for 16.48,
  "2.999" for 2.9992, "1.23" for 1.2331, "0.91" for 0.91004 — and one it could
  not place, "2.45", in three runs. The rounded forms are the check's fault, not
  the model's; see below.
- **`pdf-local-structure` and `pdf-local-geometry`**: the models answered the
  local-versus-average question from the full fit, or with `bond_geometry`,
  without a boxcar scan, or scanned without tracking the bond lengths the
  question was about.
- **`symmetry-last` (Sonnet 2/3)**: one reply was graded as proposing a lower
  symmetry: "Neither is evidence for a lower group".

## Since these runs

The follow-ups the runs called for, with what changed (on `claude/agent-skills`
after `96c4e45`):

- **"2.45".** It is `diagnose_fit`'s line-width ratio on the analysis-report
  page after the first refinement ("the observed lines are 2.45× broader than
  calculated"). The models quoted it, and the report did not carry the
  diagnosis, so the audit could not find it. The powder report now has a
  "Fit diagnosis" check computed as `diagnose_fit` computes it on the fit on
  screen: its reading (Rwp, Rexp, the background-subtracted Rwp′, Durbin–Watson)
  and each cause with its evidence.
- **Rounded numbers.** The audit already accepted a number the account rounded
  from a report value ("2.999" for a printed 2.9992). It now also accepts a
  number more precise than the report prints when it rounds to the printed
  value ("2.9992" for a printed 2.999), provided the printed value has a decimal
  and two significant digits, so a printed "1" or "0.9" vouches for nothing
  finer. A number that rounds to neither stays flagged: 16.48 is 16.5 at one
  decimal, not 16.4. Numbers that came from a tool whose output the report
  did not hold (the "2.45" case) are covered by the report change above.
  Re-grading those runs needs a new live run: their JSON reports hold the
  accounts but not the report text the audit reads (runs saved since do; see
  "Since the 2026-10-11 runs").
- **The symmetry-last grading.** The reply "Neither is evidence for a lower
  group" names "a lower group", and the check's negations did not include
  "neither"; it does now (with "nor"), and a CI test replays that sentence.
- **The boxcar step for local-structure questions.** The system prompt now says
  to answer a local-versus-average question with `boxcar_scan` (`bonds` for
  lengths), not from the full fit, and the tool's description opens with it.
- **Token usage.** Each run records the tokens the model spent (input, output,
  cache read, cache write); the live run prints the totals and writes them,
  per run and summed, to the `_OUT` report.
- **Two new scenarios** from the user's feedback on the demo:
  `instrument-thermal-apart` and `fit-range-edges` (fifteen then; 36 now).

## Since the 2026-10-11 runs

What the runs at `2eec39d` called for, on `claude/agent-skills` after `7b538df`:

- **"16.48" against "16.4".** No formatter truncates. `refine` gives the
  agreement as a JSON number, and 16.40 (16.3996) prints as `16.4`: JSON drops
  the trailing zero, and the audit reads `16.4` and `16.40` alike. 16.48 was
  the Rw before the first refinement, which the report did not carry; the
  flagged per-box and intermediate values were steps the eval's report could
  not list, as its page kept no History.
- **The report's coverage.** The report now gives the agreement before the
  Agent's first refinement, the cell check's Le Bail fit (its Rwp and cell),
  and each earlier `diagnose_fit` reading by the step it read, with the worst
  reflections. The eval's pages keep a History as the app does (each
  refinement a step), so the report lists the steps with their agreement.
- **Grader false positives.** `full-refinement` no longer reads a rule about
  what refines together ("the profile width must not refine together with the
  B values, so I'll fix width") as a refusal; `misfits-not-extra-peaks` reads
  "0 unexplained peaks" as none, and still fails "Other unexplained peaks
  could be sample-environment lines" when the tool found none;
  `sc-listing-honesty` takes "so no R_int (1570 reflections)" as the denial it
  is. Each sentence is replayed in CI.
- **Re-scoring for free.** See "Again, for free" above.

