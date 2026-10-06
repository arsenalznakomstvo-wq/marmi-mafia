@echo off
chcp 65001 >nul
title Marmi Mafia server
cd /d "%~dp0"
if not exist node_modules call npm install
echo Сервер сам перезапустится, когда меняется его код.
node --watch server.js
pause
