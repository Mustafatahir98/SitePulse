Set WinScriptHost=CreateObject("WScript.Shell")
WinScriptHost.Run Chr(34) & "C:\xampp\htdocs\Scraping\Cron\indexscrape.bat" & Chr(34), 0
Set WinScriptHost = Nothing
