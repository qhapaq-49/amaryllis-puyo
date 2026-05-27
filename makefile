CXX = g++

ifeq ($(PROF), true)
CXXPROF += -pg -no-pie
else
CXXPROF += -s
endif

ifeq ($(BUILD), debug)
CXXFLAGS += -fdiagnostics-color=always -DUNICODE -std=c++20 -Wall -Og -pg -no-pie
else
CXXFLAGS += -DUNICODE -DNDEBUG -std=c++20 -O3 -msse4 -mbmi2 -flto $(CXXPROF) -march=native
endif

ifeq ($(PEXT), true)
CXXFLAGS += -DPEXT
endif

SRC_AI = core/*.cpp ai/*.cpp ai/search/*.cpp ai/search/beam/*.cpp ai/search/dfs/*.cpp

.PHONY: all puyop tokopuyo ama_eval test clean makedir wasm deploy-tokopuyo deploy-amaryllis

all: puyop

puyop: makedir
	@$(CXX) $(CXXFLAGS) $(SRC_AI) puyop/*.cpp -o bin/puyop/puyop.exe

tokopuyo: makedir
	@$(CXX) $(CXXFLAGS) $(SRC_AI) tokopuyo/*.cpp -o bin/tokopuyo/tokopuyo.exe

ama_eval: makedir
	@$(CXX) $(CXXFLAGS) $(SRC_AI) screenshot_eval/ama_eval.cpp -o bin/screenshot_eval/ama_eval.exe

tuner: makedir
	@$(CXX) $(CXXFLAGS) $(SRC_AI) tuner/*.cpp -o bin/tuner/tuner.exe

test: makedir
	@$(CXX) $(CXXFLAGS) $(SRC_AI) test/*.cpp -o bin/test/test.exe

clean: makedir
	@rm -rf bin
	@make makedir

makedir:
	@mkdir -p bin
	@mkdir -p bin/puyop
	@mkdir -p bin/tokopuyo
	@mkdir -p bin/screenshot_eval
	@mkdir -p bin/test
	@mkdir -p bin/tuner/data

EMCC ?= /home/shiku/AI/emsdk/upstream/emscripten/emcc

wasm:
	@mkdir -p gui/static
	$(EMCC) -std=c++20 -O3 -DNDEBUG -fexceptions -pthread \
	  -msimd128 -msse -msse2 -msse3 -mssse3 -msse4.1 \
	  -s WASM=1 \
	  -s USE_PTHREADS=1 \
	  -s PTHREAD_POOL_SIZE=6 \
	  -s EXPORTED_FUNCTIONS='["_evaluate","_malloc","_free"]' \
	  -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap"]' \
	  -s ALLOW_MEMORY_GROWTH=1 \
	  --embed-file config.json \
	  $(SRC_AI) tokopuyo/wasm_main.cpp \
	  -o gui/static/ama.js

deploy-tokopuyo:
	@scripts/deploy_site.sh tokopuyo

deploy-amaryllis:
	@scripts/deploy_site.sh amaryllis

.DEFAULT_GOAL := puyop
