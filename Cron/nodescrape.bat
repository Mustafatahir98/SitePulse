if not "%minimized%"=="" goto :minimized
set minimized=true
@echo off
cd C:\xampp\htdocs\Scraping

start /min cmd /C "node index.js"
goto :EOF
:minimized
