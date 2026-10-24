P2 (High) — Python Worker (`python_workers`): intermittent init failure in `initPyInstance`
(NoGilError / "Cannot enter a promising task" SystemError) causing 502s on ~65% of invocations

## Summary

We run a Python Worker (template `python_workers`) that is called only through a Service Binding from a
TypeScript Worker. Between 2026-10-23T00:00Z and 2026-10-24T12:00Z, **3063 of 4752 invocations (64.5%)** of
the Python Worker ended with `outcome=scriptThrewException`. Every captured exception originates inside
Pyodide instance initialization (`initPyInstance` / `preparePython`), no exception contains an application
frame, and the runtime itself reports *"This is a bug in Pyodide"*.

Impact: user-facing 502s whenever our front-end needed the Python Worker. Auth and most reads are served by
the TS Worker and stayed healthy (1821 invocations, 0 errors in the same window).

We already have a workaround (we are progressively moving endpoints off the Python Worker; the TS Worker
retries idempotent GETs up to 5 times). We are opening this ticket to find out whether this is a known
runtime defect and how to avoid it until it is fixed.

## Environment

| Item | Value |
|---|---|
| Account ID | `766f8d7eb5a7d20e272673073ec8c3fd` |
| Python Worker | `kaas` (uses `python_workers`; **no public hostname**, `routes: []`) |
| Invocation path | `kaas-edge` (TS Worker) -> **Service Binding** -> `kaas` (binding URL `https://kernel.internal`) |
| compatibility_date | `2026-09-18` |
| compatibility_flags | `["python_workers"]` |
| Plan | Workers Paid (128 MB memory limit) |
| cron triggers on the Python Worker | `*/15 * * * *`, `30 16 * * *`, `40 17 * * *` (cron invocations also initialize the instance and are included below) |
| Python source size | ~800 KB compiled per isolate |
| python_modules | 11.79 MiB / 606 files |
| Measured cold start | 2.6-3.9 s (worst PoP ~10 s) |
| wrangler / pywrangler / uv | <fill exact versions> |
| Dependency lock | `pylock.toml` sha256 <fill> |

## What we observe

Two distinct exceptions, both raised while initializing the Pyodide instance:

1. `NoGilError: Attempted to use PyProxy when Python GIL not held`
   stack: `throw_no_gil (pyodideRuntime-internal) -> python_getattr -> preparePython -> initPyInstance`
2. `PythonError` wrapping `SystemError: Cannot enter a promising task from inside another running promising
   task. This is a bug in Pyodide.`
   stack: `new_error (pyodideRuntime-internal) -> callPyObjectKwargsPromising -> doPyCallHelper -> initPyInstance`

We do not know whether these two share a root cause. The second one reads like a re-entrant initialization
race (two requests initializing the same instance); please confirm or rule that out.

Additional observations:

- **Same version, same minute, same URL alternates between 502 and 200**, and recovers ~10 minutes later with
  no deploy. This rules out "the code path always fails".
- **Anonymous `GET /health` returned 200 throughout**, which is why our own monitoring did not page. We have
  since added a real-JWT error-rate gate.
- Collection method (limitation we want to state up front): the sample in A1 comes from a **single
  `wrangler tail` session** captured while our retry logic was active. It contains **all** exceptions we saw
  in that session (not a selection), but it is a small sample; A1 will include 100+ control events.

## Quantified data (re-queried 2026-10-24T13:5xZ; raw query + result in A2)

script = `kaas`, `workersInvocationsAdaptive`:

| Window | From (UTC) | To (UTC) | invocations | scriptThrewException | error rate |
|---|---|---|---|---|---|
| **A** | 2026-10-23T00:00Z | 2026-10-24T12:00Z | **4752** | **3063** | **64.5%** |
| B | 2026-10-22T00:00Z | 2026-10-24T12:00Z | 5158 | 3063 | 59.4% |
| C | 2026-10-21T00:00Z | 2026-10-24T12:00Z | 5566 | 3064 | 55.0% |

Window A breakdown: `scriptThrewException 3063` / `success 1670` / `exceededResources 15` /
`clientDisconnected 4`. Control: script `kaas-edge` = 1821 invocations, 0 errors.

Notes on the denominator (please read before comparing with other numbers):
- **invocations != user requests.** Our TS Worker retries idempotent GETs up to 5 times within ~4.4 s, so one
  user action can produce up to 5 invocations, and the 3063 includes those retries. The retries also
  *increased* init load during the incident; A7 will provide the retry-adjusted request count.
- **cron invocations are included** (the 3 triggers above also initialize the instance).

Memory (we deliberately report it as a *risk factor*, not as the cause):

| status | memoryUsageBytes P50 | P99 |
|---|---|---|
| success | 95-118 MB | **137.5 MB** |
| scriptThrewException | 96-101 MB | 119.6 MB |
| exceededResources | 96-119 MB | 138.9 MB |

Note the counter-intuitive point: **failing invocations show *lower* memory than successful ones**
(119.6 MB vs 137.5 MB), consistent with an abort early in init before the WASM heap is fully accounted.
Only the 15 `exceededResources` invocations are actual resource-limit evidence. We do **not** claim OOM is
the root cause; we only note that with a 128 MB limit and a success P99 of 137.5 MB the headroom is small.

Timing: failing invocations have `cpuTimeP50` 274-1293 µs and `wallTimeP50` 651-1895 ms (they fail during
startup); successful ones show `wallTimeP50` >= 5987 ms. We do not assert that "every request pays full init
cost" - we only observe that in this low-traffic period isolates appear to be recycled frequently, so a large
share of requests are cold. A8 will include a per-hour series and a cold/warm comparison.

Time shape: 2026-10-22 = 0 errors; errors start 2026-10-23 in clusters (peak 247/hour); **at
2026-10-24T06:49Z we deployed a new kernel version and the 07:00Z hour reached 993 (4x)** - see "Deploy
correlation" below.

### Deploy correlation (we are flagging this ourselves)

| UTC | Event |
|---|---|
| 2026-10-24T06:41:25Z | our commit `c25ffe36` (37 files) |
| 2026-10-24T06:48:06Z-06:48:19Z | we ran a DB migration (alembic upgrade head) |
| 2026-10-24T06:48:22Z-06:49:46Z | **kernel `kaas` deployed** (new version) |
| 2026-10-24T06:49:48Z-06:50:32Z | **edge `kaas-edge` deployed** |
| 2026-10-24T07:00Z | hourly errors 993 (previous peak 247) |

Until we finish the rollback control (E4 in A6) we do **not** claim the deploy is unrelated.

## Control experiments (A6; pending rows are stated as pending)

| # | Experiment | Purpose | Status |
|---|---|---|---|
| E1 | Minimal `python_workers` Worker (same account / `compatibility_date` / flags, **no app imports**), hammered with parallel cold-start requests | Is the defect reproducible **without our code**? | pending (next step) |
| E2 | Dependency bisect: hello-world -> +fastapi/pydantic -> +asyncpg -> +PyJWT/bcrypt -> our full `python_modules` | Is our init surface required to trigger it? | pending |
| E3 | 10 sequential cold requests (1 s apart) vs 10 concurrent cold requests | Tests the re-entrancy hypothesis behind the `promising task` SystemError | pending |
| E4 | Roll the Python Worker back to the previous version and watch 24 h | Controls for our 2026-10-24T06:49Z deploy | **not done - disclosed** |
| E5 | Same version, same 5-minute window: 5 failures + 5 successes with ray IDs | Shows the same code both fails and succeeds | pending (A1 has failures; needs success control) |

## What we need from you

1. Is this `initPyInstance` failure signature (`NoGilError` in `preparePython`; `SystemError: Cannot enter a
   promising task` in `doPyCallHelper`) a **known defect** in Python Workers / Pyodide? If yes: internal
   issue ID, affected runtime/Pyodide versions, estimated fix window.
2. Is the recommended mitigation to **serialize cold starts** (e.g. a Durable Object or Queue in front of the
   Python Worker), or is there a `compatibility_date` / `compatibility_flags` combination that avoids it?
3. Are the two exception types the same root cause? The second one looks like a re-entrant init race - please
   confirm or rule out.
4. If init-time memory pressure is the trigger: is 128 MB inclusive of the host heap, and should an OOM during
   init surface as `exceededResources` rather than `scriptThrewException`?
5. Can you trace one of the `rayId`s in A1 internally (including colo) to confirm the failing code path?

## How to reproduce (for Cloudflare)

We cannot ask you to call our production app (it needs our JWT, our database, and the kernel has no public
hostname). **A4 will contain a minimal reproduction Worker** - source, `wrangler` config with the same
`compatibility_date`/`compatibility_flags`, and a pressure script - in two variants: (a) hello-world with no
dependencies, (b) with a representative import set. Expected outcome per variant is listed in A6.

Our own black-box reproduction (through our front-end) is in A7 for reference only.

## Disclosures (facts that could otherwise be used to explain the failure)

1. 2026-10-24T06:48-06:50Z we deployed both Workers and the 4x spike follows that deploy; rollback control
   (E4) is **not yet done**; we do not claim it is unrelated.
2. The 3063 invocations include retries (idempotent GETs, up to 5 within ~4.4 s); retries also increased init
   load during the incident.
3. Since 2026-10-22 the Python Worker has no public hostname (`routes: []`) and is only reachable through the
   Service Binding; earlier in the week it was directly reachable, so we have no like-for-like comparison.
4. Our init is on the heavy side: ~800 KB Python source per isolate, `python_modules` 11.79 MiB / 606 files,
   measured cold start 2.6-3.9 s (worst PoP ~10 s). We had tried a lazy-import change to reduce init cost and
   rolled it back before the incident.
5. During the incident we were moving read traffic off the Python Worker, which lowers its invocation rate and
   makes isolates more likely to be recycled (hence more cold starts) - this may *increase* exposure to the
   init defect. Hypothesis only.
6. The Python Worker has 3 cron triggers; those invocations initialize instances and are included above.
7. Our 502 envelope changed during the incident window; A1 samples will be labelled with the corresponding
   edge version.
8. The 24 tail events come from a single tail session captured while retries were active; A1 will include a
   larger sample.

## Attachments

- **A1** tail JSONL: 24 failures + 100+ control events (rayId / timestamp / scriptVersion / colo where available)
- **A2** GraphQL query + raw JSON/CSV (three windows + hourly series)
- **A3** version/deploy manifest (UTC) + compatibility settings
- **A4** minimal reproduction Worker (source + wrangler config + deploy/pressure scripts) - *pending*
- **A5** dependency & bundle inventory (pylock sha256, `python_modules` size/count, dry-run bundle, tool versions)
- **A6** control experiment matrix (E1-E5) and results
- **A7** impact data (edge 502 counts, endpoints, distinct users, retry-adjusted requests) + our black-box repro
- **A8** memory/CPU/wallTime quantiles per hour (+ cold/warm comparison)
- **A9** incident timeline (UTC) including our deploys and mitigations
