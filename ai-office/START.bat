@echo off
chcp 65001 >nul
title AI 사무실
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [준비가 필요해요] Node.js 가 설치되어 있지 않아요.
  echo   1. https://nodejs.org 에서 LTS 버전을 받아 설치해 주세요.
  echo      또는 이 창에 다음을 입력: winget install OpenJS.NodeJS.LTS
  echo   2. 설치가 끝나면 이 파일을 다시 더블클릭해 주세요.
  echo.
  pause
  exit /b 1
)
where ollama >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [안내] Ollama 가 아직 없어요. AI 직원들의 두뇌예요. 무료예요.
  echo   https://ollama.com 에서 Windows 용을 받아 설치해 주세요.
  echo   또는: winget install Ollama.Ollama
  echo   설치 전에도 사무실 화면은 열 수 있어요.
  echo.
)
node app\server.js
pause
