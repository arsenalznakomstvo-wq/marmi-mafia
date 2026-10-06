@echo off
chcp 65001 >nul
title Marmi Mafia - internet
cd /d "%~dp0"
echo Ссылка для друзей появится ниже, в строке с trycloudflare.com
echo Не закрывайте это окно, пока друзья играют.
"tools\cloudflared.exe" tunnel --no-autoupdate --url http://localhost:7777 --logfile "tools\tunnel.log"
pause
