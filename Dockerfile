FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY pyproject.toml ./
RUN pip install --no-cache-dir \
      "dashscope>=1.25.0" \
      "fastapi>=0.137" \
      "uvicorn[standard]>=0.49" \
      "python-multipart>=0.0.20" \
      "websockets>=12.0"

COPY server/ ./server/
COPY static/ ./static/

# Render injects PORT; fall back to 8080 locally.
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:'+__import__('os').environ.get('PORT','8080')+'/healthz').status==200 else 1)"

CMD ["sh", "-c", "uvicorn server.main:app --host 0.0.0.0 --port ${PORT:-8080}"]