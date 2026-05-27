# syntax=docker/dockerfile:1

FROM python:3.13-slim AS builder

WORKDIR /build
RUN apt-get update \
  && apt-get install -y --no-install-recommends g++ make ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY core/ core/
COPY ai/ ai/
COPY lib/ lib/
COPY tokopuyo/ tokopuyo/
COPY screenshot_eval/ama_eval.cpp screenshot_eval/ama_eval.cpp
COPY config.json makefile ./

RUN make tokopuyo ama_eval CXXFLAGS="-DUNICODE -DNDEBUG -std=c++20 -O3 -msse4 -mbmi2 -flto -s"

FROM python:3.13-slim AS runtime

WORKDIR /app
RUN pip install --no-cache-dir numpy pillow

COPY config.json ./
COPY screen_reader/ screen_reader/
COPY screenshot_eval/server.py screenshot_eval/server.py
COPY screenshot_eval/static/ screenshot_eval/static/
COPY --from=builder /build/bin/tokopuyo/tokopuyo.exe bin/tokopuyo/tokopuyo.exe
COPY --from=builder /build/bin/screenshot_eval/ama_eval.exe bin/screenshot_eval/ama_eval.exe

ENV HOST=0.0.0.0
ENV PORT=5001
EXPOSE 5001

CMD ["python3", "screenshot_eval/server.py"]
