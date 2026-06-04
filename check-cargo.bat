@echo off
echo CHECKING CARGO > "%TEMP%\check-cargo.txt"
where cargo >> "%TEMP%\check-cargo.txt" 2>&1
where rustup >> "%TEMP%\check-cargo.txt" 2>&1
echo DONE >> "%TEMP%\check-cargo.txt"
