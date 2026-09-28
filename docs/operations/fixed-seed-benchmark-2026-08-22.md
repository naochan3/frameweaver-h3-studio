# Fixed-seed image benchmark (2026-08-22)

## Contract

- Workflow: `scripts/fixtures/fixed-seed-sdxl-high.json`
- Seed: `424242`
- Model: `RealVisXL_V5.0_fp16.safetensors`
- Resolution: 1024 x 1536
- Sampler: DPM++ 2M / Karras, 40 steps, CFG 6.0
- Cache control: every run uses unique node and prompt identifiers plus token-equivalent trailing whitespace.
- Telemetry: one-second `nvidia-smi` samples; no prompt text is written to the result artifact.

## Live results

| Host | Result | Elapsed | Peak VRAM | Peak GPU | Peak power | Peak temp |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| RTX 5060 Ti, run 1 | success | 26.14 s | 11,058 MiB | 100% | 171.73 W | 71 C |
| RTX 5060 Ti, run 2 | success | 25.98 s | 10,756 MiB | 100% | 173.34 W | 74 C |
| RTX 3070 (`nicolas2025`) | host reboot | incomplete | unknown | unknown | unknown | unknown |
| RTX 4090 | not run | n/a | n/a | n/a | n/a | n/a |
| RTX 2070 | not run | n/a | n/a | n/a | n/a | n/a |

The two successful runs differ by 0.16 seconds (0.61%). Their PNG container hashes differ because Comfy embeds run metadata, but decoded RGBA pixels have the same SHA-256:

`3D96F7DFBEE1DA05F0545C4FE54D2C5AC04779401CF7AD8271C7CEB7AF16DA58`

The image is a detailed, centered product render. Small pseudo-lettering remains around the lens and base, so this validates deterministic high-detail generation, not reliable typography.

## RTX 3070 safety stop

The RTX 3070 host lost the SSH session while the workload was running. Windows reported Kernel-Power 41 and EventLog 6008 for an unexpected shutdown at 15:41:41 JST, followed by a boot at 15:42:29 JST. There was no BugCheck 1001, WER crash entry, `MEMORY.DMP`, or recent minidump. After reboot, Comfy was not running and its scheduled task was disabled/stopped (`LastTaskResult=267011`).

This evidence does not identify a single cause. It is more consistent with a power, thermal, driver, or hardware-level reset than a normal Comfy process exception. Do not repeat this workload on the RTX 3070 or RTX 2070 until PSU capacity/cabling, GPU/CPU thermals, Windows hardware events, and a staged lower-power load have been checked.

The RTX 4090 was excluded because an unrelated Python process already occupied about 23.3 GiB VRAM at 100% GPU. It was not interrupted.

## Re-run

```powershell
pwsh -NoProfile -File scripts/Test-FixedSeedComfyBenchmark.ps1
```

Run only after confirming the selected worker is idle, healthy, and authorized for a sustained GPU load. A completed Comfy history entry, a fetched output, and a telemetry artifact are all required for success; cached or interrupted runs are not benchmark evidence.
