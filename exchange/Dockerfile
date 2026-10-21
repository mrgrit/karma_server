FROM python:3.12-slim
WORKDIR /app
COPY app.py ledger.py migrate_admin_million.py ./
COPY public ./public
RUN useradd --uid 10001 --no-create-home exchange && mkdir /data && chown exchange:exchange /data
USER 10001:10001
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
EXPOSE 8080
CMD ["python", "app.py"]
