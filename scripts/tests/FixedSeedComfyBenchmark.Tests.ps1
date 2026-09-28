Describe 'Fixed seed Comfy benchmark contract' {
    BeforeAll {
        $repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
        $fixturePath = Join-Path $repoRoot 'scripts\fixtures\fixed-seed-sdxl-high.json'
        $scriptPath = Join-Path $repoRoot 'scripts\Test-FixedSeedComfyBenchmark.ps1'
        $script:workflow = Get-Content -Raw -LiteralPath $fixturePath | ConvertFrom-Json
        $script:benchmarkSource = Get-Content -Raw -LiteralPath $scriptPath
    }

    It 'pins the reproducible high-quality workload' {
        [int64]$workflow.sampler.inputs.seed | Should Be 424242
        [int]$workflow.latent.inputs.width | Should Be 1024
        [int]$workflow.latent.inputs.height | Should Be 1536
        [int]$workflow.sampler.inputs.steps | Should Be 40
        $workflow.sampler.inputs.sampler_name | Should Be 'dpmpp_2m'
        $workflow.sampler.inputs.scheduler | Should Be 'karras'
    }

    It 'invalidates Comfy cache without changing the semantic prompt' {
        $benchmarkSource | Should Match "inputs\.text \+= \(' ' \*"
        $benchmarkSource | Should Match 'samplerNodeId = "sampler_'
    }

    It 'emits bounded telemetry without embedding prompt text' {
        $benchmarkSource | Should Match "frameweaver\.fixed_benchmark\.v1"
        $benchmarkSource | Should Match 'peak_vram_mib'
        $benchmarkSource | Should Match 'peak_power_w'
        $benchmarkSource | Should Not Match 'result.*positive'
        $benchmarkSource | Should Not Match 'result.*negative'
    }
}
