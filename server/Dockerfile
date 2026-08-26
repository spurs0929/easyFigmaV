FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# 不以 root 執行。Render 不會強制，但這是零成本的縱深防禦
RUN useradd --create-home --uid 10001 appuser && chown -R appuser:appuser /app
USER appuser

# alembic upgrade head：每次 deploy 自動套用 migration，失敗就不會啟動，避免舊程式對新 schema 做錯誤操作
# exec：讓 uvicorn 接手 PID 1，才收得到 Render 的 SIGTERM 做優雅關閉
# --proxy-headers / --forwarded-allow-ips：Render 在反向代理後面，少了這兩個
#   request.url.scheme 會是 http、request.client.host 會是代理 IP，
#   之後設 Secure cookie 和依 IP 做登入速率限制都會壞掉
CMD ["sh", "-c", "alembic upgrade head && exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips='*'"]