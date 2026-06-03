import os
import json
import re
import sqlite3
from datetime import datetime, date
from pathlib import Path

from flask import Flask, request, jsonify, render_template
from dotenv import load_dotenv
from google import genai
from google.genai import types

load_dotenv()

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024  # 16MB

# ── AI ──────────────────────────────────────────────────────────────────────
_raw_key = os.environ.get("GEMINI_API_KEY", "").strip()
_PLACEHOLDERS = {"", "your_gemini_api_key_here", "ここにgemini_apiキーを貼り付け"}
GEMINI_API_KEY = "" if _raw_key.lower() in _PLACEHOLDERS else _raw_key
ai_client = genai.Client(api_key=GEMINI_API_KEY) if GEMINI_API_KEY else None
GEMINI_MODEL = "gemini-2.5-flash"

# ── DB ──────────────────────────────────────────────────────────────────────
DATABASE_URL = os.environ.get("DATABASE_URL", "")
IS_PG = bool(DATABASE_URL)
PH = "%s" if IS_PG else "?"          # placeholder
DB_PATH = Path(__file__).parent / "kakeibo.db"

CATEGORIES = [
    "食費", "外食", "日用品", "交通費", "衣類・美容",
    "医療・健康", "娯楽・趣味", "光熱費", "通信費", "その他",
]


def _pg():
    import psycopg2
    import psycopg2.extras
    return psycopg2, psycopg2.extras


def db_query(sql, params=()):
    if IS_PG:
        pg, extras = _pg()
        conn = pg.connect(DATABASE_URL)
        try:
            with conn.cursor(cursor_factory=extras.RealDictCursor) as cur:
                cur.execute(sql, params)
                rows = cur.fetchall()
            conn.commit()
        finally:
            conn.close()
        return [dict(r) for r in rows]
    else:
        conn = sqlite3.connect(str(DB_PATH))
        conn.row_factory = sqlite3.Row
        rows = conn.execute(sql, params).fetchall()
        conn.commit()
        conn.close()
        return [dict(r) for r in rows]


def db_execute(sql, params=()):
    if IS_PG:
        pg, _ = _pg()
        conn = pg.connect(DATABASE_URL)
        try:
            with conn.cursor() as cur:
                cur.execute(sql, params)
            conn.commit()
        finally:
            conn.close()
    else:
        conn = sqlite3.connect(str(DB_PATH))
        conn.execute(sql, params)
        conn.commit()
        conn.close()


def db_fetchone(sql, params=()):
    rows = db_query(sql, params)
    return rows[0] if rows else None


def init_db():
    pk = "SERIAL PRIMARY KEY" if IS_PG else "INTEGER PRIMARY KEY AUTOINCREMENT"
    db_execute(f"""
        CREATE TABLE IF NOT EXISTS expenses (
            id {pk},
            date TEXT NOT NULL,
            store TEXT NOT NULL,
            category TEXT NOT NULL,
            total INTEGER NOT NULL,
            items TEXT NOT NULL,
            memo TEXT,
            created_at TEXT NOT NULL
        )
    """)


# ── Routes ──────────────────────────────────────────────────────────────────

@app.route("/api/status")
def status():
    return jsonify({"api_key_set": bool(GEMINI_API_KEY)})


@app.route("/")
def index():
    return render_template("index.html", categories=CATEGORIES)


@app.route("/api/analyze", methods=["POST"])
def analyze():
    if "image" not in request.files:
        return jsonify({"error": "画像が見つかりません"}), 400

    file = request.files["image"]
    if not file.filename:
        return jsonify({"error": "ファイルが選択されていません"}), 400

    image_data = file.read()
    mime_type = file.content_type or "image/jpeg"

    prompt = """このレシート画像から以下の情報をJSON形式で抽出してください。
日本語のレシートの場合はそのまま日本語で返してください。

返すJSONの形式:
{
  "store": "店舗名",
  "date": "YYYY-MM-DD形式の日付（不明な場合は今日の日付）",
  "category": "カテゴリ（食費/外食/日用品/交通費/衣類・美容/医療・健康/娯楽・趣味/光熱費/通信費/その他 から最適なもの）",
  "total": 合計金額（整数、円単位）,
  "items": [
    {"name": "商品名", "price": 金額（整数）, "qty": 数量（整数）}
  ],
  "memo": "特記事項（なければ空文字）"
}

注意:
- 合計金額が不明な場合は品目の合計を計算する
- 日付がレシートにない場合は今日の日付を使う
- JSONのみを返し、説明文は不要"""

    if not ai_client:
        return jsonify({"error": "Gemini APIキーが未設定です。.envファイルに GEMINI_API_KEY を追加してください。\nGoogle AI Studio（https://aistudio.google.com/）で無料取得できます。"}), 503

    try:
        response = ai_client.models.generate_content(
            model=GEMINI_MODEL,
            contents=[
                types.Part.from_bytes(data=image_data, mime_type=mime_type),
                prompt,
            ],
        )
        raw = response.text.strip()
        match = re.search(r"\{[\s\S]*\}", raw)
        if match:
            raw = match.group()
        result = json.loads(raw)
        if not result.get("date"):
            result["date"] = date.today().isoformat()
        return jsonify(result)
    except json.JSONDecodeError:
        return jsonify({"error": "レシートの解析に失敗しました。画像が不鮮明な可能性があります。"}), 422
    except Exception as e:
        err = str(e)
        if any(k in err for k in ["API_KEY", "api_key", "401", "403", "authentication", "UNAUTHENTICATED"]):
            return jsonify({"error": "Gemini APIキーが無効か期限切れです。Google AI Studio で新しいキーを取得してください。"}), 401
        return jsonify({"error": f"解析エラー: {err}"}), 500


@app.route("/api/expenses", methods=["POST"])
def save_expense():
    data = request.json
    for field in ["date", "store", "category", "total", "items"]:
        if field not in data:
            return jsonify({"error": f"{field} が必要です"}), 400

    db_execute(
        f"INSERT INTO expenses (date, store, category, total, items, memo, created_at) VALUES ({PH},{PH},{PH},{PH},{PH},{PH},{PH})",
        (
            data["date"],
            data["store"],
            data["category"],
            int(data["total"]),
            json.dumps(data["items"], ensure_ascii=False),
            data.get("memo", ""),
            datetime.now().isoformat(),
        ),
    )
    return jsonify({"ok": True})


@app.route("/api/expenses", methods=["GET"])
def list_expenses():
    month = request.args.get("month")
    if month:
        rows = db_query(
            f"SELECT * FROM expenses WHERE date LIKE {PH} ORDER BY date DESC",
            (f"{month}%",),
        )
    else:
        rows = db_query("SELECT * FROM expenses ORDER BY date DESC LIMIT 100")

    for e in rows:
        e["items"] = json.loads(e["items"])
    return jsonify(rows)


@app.route("/api/expenses/<int:expense_id>", methods=["DELETE"])
def delete_expense(expense_id):
    db_execute(f"DELETE FROM expenses WHERE id = {PH}", (expense_id,))
    return jsonify({"ok": True})


@app.route("/api/summary", methods=["GET"])
def summary():
    month = request.args.get("month", date.today().strftime("%Y-%m"))
    rows = db_query(
        f"SELECT category, SUM(total) as total FROM expenses WHERE date LIKE {PH} GROUP BY category ORDER BY total DESC",
        (f"{month}%",),
    )
    total_row = db_fetchone(
        f"SELECT SUM(total) as total FROM expenses WHERE date LIKE {PH}",
        (f"{month}%",),
    )
    return jsonify({
        "month": month,
        "by_category": rows,
        "total": total_row["total"] or 0 if total_row else 0,
    })


@app.route("/api/months", methods=["GET"])
def months():
    if IS_PG:
        rows = db_query(
            "SELECT DISTINCT LEFT(date, 7) as month FROM expenses ORDER BY month DESC LIMIT 24"
        )
    else:
        rows = db_query(
            "SELECT DISTINCT substr(date,1,7) as month FROM expenses ORDER BY month DESC LIMIT 24"
        )
    return jsonify([r["month"] for r in rows])


init_db()

if __name__ == "__main__":
    app.run(debug=True, port=5000)
