$out = @()
$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if ($cargo) {
    $out += "FOUND: $($cargo.Source)"
} else {
    $out += "NOT_FOUND: cargo not in PATH"
}
$rustup = Get-Command rustup -ErrorAction SilentlyContinue
if ($rustup) {
    $out += "RUSTUP FOUND: $($rustup.Source)"
} else {
    $out += "RUSTUP NOT_FOUND"
}
$out += "PATH: " + $env:PATH
$out | Out-File "$env:TEMP\check-cargo.txt" -Encoding UTF8
