FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py ledger.py common.py economy.py migrate_admin_million.py chain_backend.py chain_ledger.py deploy_chain.py ./
COPY chain/artifacts ./chain/artifacts
COPY public ./public
RUN useradd --uid 10001 --no-create-home exchange && mkdir /data && chown exchange:exchange /data
USER 10001:10001
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
EXPOSE 8080
CMD ["python", "app.py"]
