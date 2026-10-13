FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY pyproject.toml ./
COPY server/ ./server/
# 依赖装 pyproject，不在这里手抄一遍。手抄过一次，漏掉了 server/llm.py 直接
# import 的 requests 和 Vercel 声音复刻要用的 vercel，只靠传递依赖侥幸能跑。
# 改依赖只改 pyproject 一处。
RUN pip install --no-cache-dir .

COPY static/ ./static/

# Render injects PORT; fall back to 8080 locally.
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:'+__import__('os').environ.get('PORT','8080')+'/healthz').status==200 else 1)"

CMD ["sh", "-c", "uvicorn server.main:app --host 0.0.0.0 --port ${PORT:-8080}"]