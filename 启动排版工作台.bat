@echo off
chcp 65001 >nul
title 生信大杂烩 · 微信公众号排版工作台 (Claude UI Edition)
echo ============================================================
echo   正在启动「生信大杂烩 · 微信公众号排版工作台」...
echo   服务就绪后浏览器将自动打开 http://127.0.0.1:8765
echo ============================================================
where python >nul 2>nul || (echo [错误] 未找到 python，请先安装 Python 3.8+ 并加入 PATH & pause & exit /b 1)
python "%~dp0server.py" 8765 --open
pause
