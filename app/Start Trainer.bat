@echo off
rem DF Trainer: opens the trainer panel (a separate window, the launcher is not touched).
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0Start-Trainer.ps1"
