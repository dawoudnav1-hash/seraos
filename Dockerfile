FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml README.md ./
COPY outbound ./outbound
RUN pip install --no-cache-dir .
COPY config/seller.example.toml ./config/seller.example.toml
ENV OUTBOUND_HOME=/app PYTHONUNBUFFERED=1
# Mount config/seller.toml, credentials.json and a persistent data/ volume (holds the DB and Google token).
# Authorize Google once locally (`outbound google-auth`) and mount the resulting data/google_token.json.
VOLUME ["/app/data"]
EXPOSE 8000
CMD ["sh", "-c", "outbound init && (outbound worker &) && outbound serve --host 0.0.0.0 --port 8000"]
