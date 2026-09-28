$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$argsScript = Join-Path $repoRoot 'scripts\Get-ComfyProfileArgs.ps1'
$diagnosticScript = Join-Path $repoRoot 'scripts\Test-ComfyProfile.ps1'
$profileConfig = Join-Path $repoRoot 'config\comfy-profiles.json'

Describe 'Comfy custom-node profiles' {
    It 'accepts each declared profile name and defaults to full' {
        foreach ($profile in @('minimal', 'image', 'video', 'full')) {
            $failure = $null
            try { & $argsScript -Profile $profile -ConfigPath $profileConfig | Out-Null } catch { $failure = $_ }
            $failure | Should Be $null
        }

        @(& $argsScript -ConfigPath $profileConfig).Count | Should Be 0
    }

    It 'rejects an unknown profile name' {
        $failure = $null
        try { & $argsScript -Profile 'unknown' -ConfigPath $profileConfig | Out-Null } catch { $failure = $_.Exception.Message }
        $failure | Should Match 'Unknown Comfy profile'
    }

    It 'rejects duplicate custom nodes in a profile' {
        $duplicateConfig = Join-Path $TestDrive 'duplicate-profiles.json'
        @{
            defaultProfile = 'full'
            profiles = @{
                full = @{ mode = 'all'; customNodes = @('frameweaver_openfolder', 'frameweaver_openfolder') }
            }
        } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $duplicateConfig -Encoding UTF8

        $failure = $null
        try { & $argsScript -Profile 'full' -ConfigPath $duplicateConfig | Out-Null } catch { $failure = $_.Exception.Message }
        $failure | Should Match 'duplicate custom node'
    }

    It 'reports no custom-node expectations for the image core-workflow profile' {
        $customNodes = Join-Path $TestDrive 'custom_nodes'
        New-Item -ItemType Directory -Path $customNodes | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $customNodes 'ComfyUI_IPAdapter_plus') | Out-Null

        $report = & $diagnosticScript -Profile 'image' -ConfigPath $profileConfig -CustomNodesPath $customNodes

        $report.Profile | Should Be 'image'
        @($report.Expected).Count | Should Be 0
        @($report.Missing).Count | Should Be 0
        @($report.Present).Count | Should Be 0
        @($report.ImportFailures).Count | Should Be 0
    }

    It 'reports every missing full-profile custom node directly' {
        $customNodes = Join-Path $TestDrive 'missing-full-custom_nodes'
        New-Item -ItemType Directory -Path $customNodes | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $customNodes 'frameweaver_openfolder') | Out-Null

        $report = & $diagnosticScript -Profile 'full' -ConfigPath $profileConfig -CustomNodesPath $customNodes

        @($report.Present) | Should Match 'frameweaver_openfolder'
        @($report.Missing).Count | Should Be 7
        (@($report.Missing) -join "`n") | Should Match 'ComfyUI_IPAdapter_plus'
        @($report.ImportFailures).Count | Should Be 0
    }

    It 'expands every profile to its exact ordered CLI argument array' {
        $expectedByProfile = @{
            minimal = @('--disable-all-custom-nodes')
            image = @('--disable-all-custom-nodes')
            video = @('--disable-all-custom-nodes')
            full = @()
        }

        foreach ($profile in @('minimal', 'image', 'video', 'full')) {
            $actual = @(& $argsScript -Profile $profile -ConfigPath $profileConfig)
            ($actual -join "`n") | Should Be ($expectedByProfile[$profile] -join "`n")
        }
    }

    It 'allows the open-folder remote GUI endpoint only in full' {
        (& $diagnosticScript -Profile 'full' -ConfigPath $profileConfig -CustomNodesPath $TestDrive).OpenFolderEndpointAllowed | Should Be $true
        (& $diagnosticScript -Profile 'image' -ConfigPath $profileConfig -CustomNodesPath $TestDrive).OpenFolderEndpointAllowed | Should Be $false
    }
}
