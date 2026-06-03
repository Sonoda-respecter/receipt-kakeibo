@echo off
cd /d "%~dp0"

if not exist ".env" (
    echo .env ファイルがありません。.env.example をコピーして APIキーを設定してください。
    pause
    exit /b 1
)

if not exist "venv\Scripts\activate.bat" (
    echo 仮想環境を作成中...
    python -m venv venv
    call venv\Scripts\activate.bat
    pip install -r requirements.txt
) else (
    call venv\Scripts\activate.bat
)

echo サーバー起動中... http://localhost:5000 をブラウザで開いてください
python app.py
pause
