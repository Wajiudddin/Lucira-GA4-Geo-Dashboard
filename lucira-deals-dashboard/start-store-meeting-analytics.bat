@echo off
cd /d "%~dp0"
title Lucira Dashboard - server
rem Starts the server in its own window (keep that window open) and opens the
rem Store Meeting & Conversion Analytics page. First load takes ~2 minutes.
start "Lucira Dashboard - server" cmd /k "npm start"
timeout /t 4 /nobreak >nul
start "" http://localhost:3000/store-meeting-analytics.html
