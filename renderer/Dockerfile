FROM python:3.14-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && useradd --uid 10001 --create-home renderer
COPY server.py render.py ./
USER renderer
EXPOSE 8080
CMD ["python", "server.py"]
