# ComfyUI idle resource analysis

Measured 2026-08-22 JST from `rtx4090` with roster SHA-256
`405D699D89456B2F64C626BD19C5018C89824C595C4508E77510AD342224A812`.
The sampler took 60 one-second logical samples per host and did not start, stop,
or reconfigure ComfyUI. Raw prompt, command line, environment, and Discord data
are intentionally excluded.

| Host | Observed state | Comfy private median | VRAM median | GPU median / p95 | Power median | P-state |
|---|---|---:|---:|---:|---:|---|
| RTX 5060 Ti | started, compute-idle | 10.10 GiB | 8,210 MiB | 0% / 1% | 12.3 W | P8 |
| RTX 3070 | started, compute-idle | 10.76 GiB | 7,674 MiB | 0% / 1% | 13.76 W | P8 |
| RTX 2070 | Comfy stopped | 0 | 871 MiB | 0% / 0% | 12.75 W | P0 |
| RTX 4090 | contaminated by unrelated active Python workload | 17.70 GiB | 20,307 MiB | 77% / 90% | 248.7 W | P2 |

The 5060 Ti and 3070 results show allocator/model residency rather than active
generation: utilization stayed at zero while VRAM and private bytes were flat.
Keeping those workers warm costs about 8 GiB VRAM and 10-11 GiB committed host
memory each, but only about 12-14 W GPU board power in this sample.

The 2070 is the current stopped baseline. Its 871 MiB VRAM is desktop/driver
baseline, not ComfyUI. Board power alternated enough to produce median 12.75 W
and p95 25.08 W; P0 therefore must not be interpreted as Comfy activity.

The 4090 sample is not an idle baseline. Comfy PID 44788 was resident with
17.70 GiB private bytes, but Windows GPU Engine counters attributed zero engine
use to it. PID 80004, a separate Python process started at 14:05 JST, accounted
for the active GPU engines. Comfy `/queue` returned running=0 and pending=0.
The 4090 row must not be used to estimate Comfy idle power or utilization.

## Operational policy

- Keep 5060 Ti and 3070 warm when latency matters; their idle compute cost is
  small, but capacity reporting must subtract their resident 8 GiB VRAM.
- Keep 2070 stopped/on-demand until its worker deployment is ready; its current
  baseline proves that stopped Comfy releases host process memory.
- On 4090, separate daemon availability from model residency. Prefer an
  idle-time model unload first, then stop Comfy after a longer idle timeout.
  Never unload while a job is queued/running, and re-check the job ledger plus
  Comfy queue immediately before the action.
- Re-run `post_generation_idle` after the unrelated PID 80004 workload ends.
  A valid 4090 comparison requires the same 60-s sampler with GPU utilization
  near zero and no non-Comfy compute process.

`scripts/Measure-ComfyIdleResources.ps1` emits schema
`frameweaver.comfy_idle.v1` with median/p95/max summaries. Production raw output
belongs under `%LOCALAPPDATA%\FrameWeaver\analysis`, outside the repository.
