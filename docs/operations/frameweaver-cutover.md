# FrameWeaver 5180 cutover runbook

`scripts/Invoke-FrameWeaverCutover.ps1` is dry-run by default. It does not
change a Scheduled Task, process, Tailscale Serve target, or ComfyUI unless
both `-Apply` and a writable `-BackupDirectory` are supplied.

## Preconditions

1. Run the full Rust, npm, and Pester gates and retain their output.
2. Review the dry-run result. It must identify exactly one listener on 5180,
   resolve its PID through `Win32_Process`, and classify it as a repo-local
   Node/Vite command line. A PID, executable, or command-line mismatch is a
   hard stop.
3. Prepare an operator-controlled backup directory outside the worktree.

## Apply

```powershell
scripts\Invoke-FrameWeaverCutover.ps1 -ProjectRoot <repo> -BackupDirectory <safe-backup>
scripts\Invoke-FrameWeaverCutover.ps1 -ProjectRoot <repo> -BackupDirectory <safe-backup> -Apply
```

The apply path exports the same-name task XML and records a probe manifest. If
5180 is occupied, it stops only a verified Vite PID; if it is already free,
it proceeds without stopping anything. It then requires 5180 to be free,
replaces and starts the task, then retries `/api/health` for up to 30 seconds
(200 ms interval) until it has `service=ready`, `database=ready`, and build
metadata. If that check fails, it stops only a verified repo-local daemon (or
continues when no listener remains), restores the saved XML, starts the old
task, and retries the captured legacy probe. An unknown listener fails closed:
the backup remains and the error names manual recovery rather than stopping an
unverified PID. It does not modify Tailscale Serve or `Shirokuma-ComfyUI`.

## Rollback

```powershell
scripts\Invoke-FrameWeaverCutover.ps1 -ProjectRoot <repo> -BackupDirectory <safe-backup> -Apply -Rollback
```

Rollback stops only a verified repo-local `frameweaverd` listener, but also
accepts an already-free 5180 listener. It then verifies 5180 is free, restores
the saved XML, explicitly starts the old task, and retries the old Vite
contract (`/` HTTP 200 and `/api/fleet` JSON) recorded in the manifest for up
to 30 seconds. Any identity mismatch fails closed; do not force-kill a PID
based on port ownership alone.
