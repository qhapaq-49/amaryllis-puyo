#ifdef __EMSCRIPTEN__

#include <iostream>
#include <fstream>
#include <map>
#include <string>
#include <emscripten/emscripten.h>
#include "../ai/search/beam/beam.h"

// ─── 重み読み込み ─────────────────────────────────────────────────────────────
// load_weights と parse_* は main.cpp と同じロジック
static std::map<std::string, beam::eval::Weight> g_weights;
static bool g_weights_loaded = false;

static void ensure_weights()
{
    if (g_weights_loaded) return;
    g_weights_loaded = true;

    std::ifstream f("config.json");
    if (!f.good()) return;

    json js;
    f >> js;

    for (auto& [key, val] : js.items()) {
        try {
            beam::eval::Weight w;
            from_json(val, w);
            g_weights[key] = w;
        }
        catch (...) {
            g_weights[key] = beam::eval::Weight();
        }
    }
}

static bool parse_field(const json& rows, Field& out, std::string& err)
{
    if (!rows.is_array() || rows.size() != 13) {
        err = "field must be an array of exactly 13 strings";
        return false;
    }
    char c[13][7];
    for (int i = 0; i < 13; ++i) {
        if (!rows[i].is_string()) { err = "each field row must be a string"; return false; }
        auto row = rows[i].get<std::string>();
        if (row.size() != 6) { err = "each field row must be exactly 6 characters"; return false; }
        for (int x = 0; x < 6; ++x) {
            char ch = row[x];
            if (ch != 'R' && ch != 'Y' && ch != 'G' && ch != 'B' && ch != '#' && ch != '.') {
                err = std::string("invalid cell character: ") + ch;
                return false;
            }
            c[i][x] = ch;
        }
        c[i][6] = '\0';
    }
    out.from(c);
    return true;
}

static bool parse_queue(const json& pairs, cell::Queue& out, std::string& err)
{
    if (!pairs.is_array() || pairs.size() < 2) {
        err = "queue must be an array of at least 2 pairs";
        return false;
    }
    for (auto& pair : pairs) {
        if (!pair.is_array() || pair.size() != 2) {
            err = "each queue entry must be an array of 2 color strings";
            return false;
        }
        auto a = pair[0].get<std::string>();
        auto b = pair[1].get<std::string>();
        cell::Type ca = cell::from_char(a[0]);
        cell::Type cb = cell::from_char(b[0]);
        if (ca == cell::Type::NONE || ca == cell::Type::GARBAGE ||
            cb == cell::Type::NONE || cb == cell::Type::GARBAGE) {
            err = "invalid queue color: use R/Y/G/B only";
            return false;
        }
        out.push_back({ ca, cb });
    }
    return true;
}

static std::string direction_to_string(direction::Type r)
{
    switch (r) {
    case direction::Type::UP:    return "UP";
    case direction::Type::RIGHT: return "RIGHT";
    case direction::Type::DOWN:  return "DOWN";
    case direction::Type::LEFT:  return "LEFT";
    }
    return "UP";
}

static bool fires_chain(const Field& field, const move::Placement& p, const cell::Pair& pair)
{
    Field copy = field;
    copy.drop_pair(p.x, p.r, pair);
    auto mask = copy.pop();
    return mask.get_size() > 0;
}

// ─── エクスポート関数 ─────────────────────────────────────────────────────────
// JS から: Module.ccall('evaluate', 'string', ['string'], [jsonInput])
// 戻り値は static std::string の c_str() - 次の呼び出しまで有効

extern "C" {

EMSCRIPTEN_KEEPALIVE
const char* evaluate(const char* json_input)
{
    static std::string result;

    ensure_weights();

    json response;

    try {
        json req = json::parse(json_input);

        Field field;
        std::string err;

        if (!req.contains("field")) {
            response = {{"error", "missing field 'field'"}};
            result = response.dump();
            return result.c_str();
        }
        if (!parse_field(req["field"], field, err)) {
            response = {{"error", err}};
            result = response.dump();
            return result.c_str();
        }

        cell::Queue queue;
        if (!req.contains("queue")) {
            response = {{"error", "missing field 'queue'"}};
            result = response.dump();
            return result.c_str();
        }
        if (!parse_queue(req["queue"], queue, err)) {
            response = {{"error", err}};
            result = response.dump();
            return result.c_str();
        }

        bool no_fire = false;
        std::string weight_name = "build";
        beam::Configs beam_configs;
        if (req.contains("options")) {
            auto& opts = req["options"];
            if (opts.contains("no_fire") && opts["no_fire"].is_boolean())
                no_fire = opts["no_fire"].get<bool>();
            if (opts.contains("weights") && opts["weights"].is_string())
                weight_name = opts["weights"].get<std::string>();
            if (opts.contains("width") && opts["width"].is_number_integer())
                beam_configs.width = std::max(1, opts["width"].get<int>());
            if (opts.contains("depth") && opts["depth"].is_number_integer())
                beam_configs.depth = std::max(1, opts["depth"].get<int>());
        }

        beam::eval::Weight w;
        if (g_weights.count(weight_name))
            w = g_weights.at(weight_name);
        else if (!g_weights.empty())
            w = g_weights.begin()->second;

        auto t0 = std::chrono::high_resolution_clock::now();
        auto res = beam::search_multi(field, queue, w, beam_configs);
        auto t1 = std::chrono::high_resolution_clock::now();
        i32 elapsed_ms = (i32)std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();

        json candidates = json::array();
        bool filtered_any = false;

        for (auto& c : res.candidates) {
            if (no_fire && fires_chain(field, c.placement, queue[0])) {
                filtered_any = true;
                continue;
            }
            candidates.push_back({
                {"x", (int)c.placement.x},
                {"r", direction_to_string(c.placement.r)},
                {"score", (int)c.score},
                {"expected_score", (int)(c.score / beam::BRANCH)}
            });
        }

        if (no_fire && candidates.empty() && filtered_any) {
            for (auto& c : res.candidates) {
                candidates.push_back({
                    {"x", (int)c.placement.x},
                    {"r", direction_to_string(c.placement.r)},
                    {"score", (int)c.score},
                    {"expected_score", (int)(c.score / beam::BRANCH)}
                });
            }
            response["warning"] = "no_fire filtered all candidates; returning unfiltered results";
        }

        response["candidates"] = candidates;
        response["elapsed_ms"] = elapsed_ms;
    }
    catch (const json::exception& e) {
        response = {{"error", std::string("JSON error: ") + e.what()}};
    }
    catch (const std::exception& e) {
        response = {{"error", std::string("error: ") + e.what()}};
    }

    result = response.dump();
    return result.c_str();
}

} // extern "C"

#endif // __EMSCRIPTEN__
