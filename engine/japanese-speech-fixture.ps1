# Local speech only: this is a language-path test, NOT proof of singing accuracy.
Add-Type -AssemblyName System.Speech
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskFolder = Join-Path $taskRoot '.studio-data/verification'
New-Item -ItemType Directory -Force -Path $taskFolder | Out-Null
$taskVoice = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $taskVoice.SelectVoice('Microsoft Haruka Desktop')
    $taskVoice.SetOutputToWaveFile((Join-Path $taskFolder 'japanese-speech.wav'))
    $taskVoice.Speak('星の光が、夜を照らす。')
    $taskVoice.Speak('あなたと歩いた、この道。')
    $taskVoice.SelectVoice('Microsoft Zira Desktop')
    $taskVoice.Speak('Hello, my shining star.')
    $taskVoice.SelectVoice('Microsoft Haruka Desktop')
    $taskVoice.Speak('星の光が、夜を照らす。')
} finally { $taskVoice.Dispose() }
