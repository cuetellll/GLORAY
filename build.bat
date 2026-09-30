@echo off
chcp 65001 >nul
echo [1/3] npm install ...
call npm install || goto :err
echo [2/3] downloading sing-box core ...
call npm run core || goto :err
echo [3/3] building exe ...
call npm run dist || goto :err
echo.
echo Done! Look in the "dist" folder.
pause
exit /b 0
:err
echo Build failed.
pause
exit /b 1
