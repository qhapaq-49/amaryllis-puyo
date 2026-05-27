#include <iostream>
#include <fstream>
#include <iomanip>
#include <map>
#include <chrono>
#include "../ai/search/beam/beam.h"

// load_weights: config.json から全プロファイルを読み込む
// config.json の構造: {"build": {...}, "ac": {...}, "fast": {...}, "freestyle": {...}}
// 各プロファイルのキーは beam::eval::Weight のフィールドに対応
// "form" キーが無いプロファイルもあるため、プロファイル毎に try-catch する
std::map<std::string, beam::eval::Weight> load_weights()
{
    std::map<std::string, beam::eval::Weight> result;

    std::ifstream f("config.json");
    if (!f.good()) {
        return result;
    }

    json js;
    f >> js;

    for (auto& [key, val] : js.items()) {
        try {
            beam::eval::Weight w;
            from_json(val, w);
            result[key] = w;
        }
        catch (...) {
            // 一部キーが欠けているプロファイル (form など) は
            // デフォルト値 (0) のまま登録
            result[key] = beam::eval::Weight();
        }
    }

    return result;
}

// parse_field: JSONの13行×6文字配列を Field に変換
// c[0] = 上端行 (row 13), c[12] = 下端行 (row 1)
// Field::from() も同じ規約を使う
bool parse_field(const json& rows, Field& out_field, std::string& err)
{
    if (!rows.is_array() || rows.size() != 13) {
        err = "field must be an array of exactly 13 strings";
        return false;
    }

    char c[13][7];

    for (int i = 0; i < 13; ++i) {
        if (!rows[i].is_string()) {
            err = "each field row must be a string";
            return false;
        }

        auto row = rows[i].get<std::string>();

        if (row.size() != 6) {
            err = "each field row must be exactly 6 characters";
            return false;
        }

        for (int x = 0; x < 6; ++x) {
            char ch = row[x];
            if (ch != 'R' && ch != 'Y' && ch != 'G' && ch != 'B' && ch != '#' && ch != '.') {
                err = std::string("invalid cell character: ") + ch + " (use R/Y/G/B/#/.)";
                return false;
            }
            c[i][x] = ch;
        }
        c[i][6] = '\0';
    }

    out_field.from(c);
    return true;
}

// parse_queue: JSON配列 [["R","Y"], ["G","B"], ...] を cell::Queue に変換
// 最低2ペア必要 (beam::search_multi が内部で残りを補完する)
bool parse_queue(const json& pairs, cell::Queue& out_queue, std::string& err)
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

        if (!pair[0].is_string() || !pair[1].is_string()) {
            err = "queue colors must be strings";
            return false;
        }

        auto a = pair[0].get<std::string>();
        auto b = pair[1].get<std::string>();

        if (a.size() != 1 || b.size() != 1) {
            err = "queue color must be a single character (R/Y/G/B)";
            return false;
        }

        cell::Type ca = cell::from_char(a[0]);
        cell::Type cb = cell::from_char(b[0]);

        if (ca == cell::Type::NONE || ca == cell::Type::GARBAGE ||
            cb == cell::Type::NONE || cb == cell::Type::GARBAGE) {
            err = std::string("invalid queue color: use R/Y/G/B only");
            return false;
        }

        out_queue.push_back({ ca, cb });
    }

    return true;
}

// direction_to_string: 方向を文字列に変換
std::string direction_to_string(direction::Type r)
{
    switch (r) {
    case direction::Type::UP:    return "UP";
    case direction::Type::RIGHT: return "RIGHT";
    case direction::Type::DOWN:  return "DOWN";
    case direction::Type::LEFT:  return "LEFT";
    }
    return "UP";
}

// fires_chain: 1手目を置いたときにpopが発生するか確認
// no_fire フィルタリングに使用
bool fires_chain(const Field& field, const move::Placement& p, const cell::Pair& pair)
{
    Field copy = field;
    copy.drop_pair(p.x, p.r, pair);
    auto mask = copy.pop();
    return mask.get_size() > 0;
}

int main()
{
    auto weights = load_weights();
    beam::eval::Weight default_weight;

    std::string line;

    while (std::getline(std::cin, line)) {
        if (line.empty()) {
            continue;
        }

        json response;

        try {
            json req = json::parse(line);

            // フィールド解析
            Field field;
            std::string err;

            if (!req.contains("field")) {
                std::cout << json{{"error", "missing field 'field'"}}.dump() << "\n";
                std::cout.flush();
                continue;
            }

            if (!parse_field(req["field"], field, err)) {
                std::cout << json{{"error", err}}.dump() << "\n";
                std::cout.flush();
                continue;
            }

            // ツモ解析
            cell::Queue queue;

            if (!req.contains("queue")) {
                std::cout << json{{"error", "missing field 'queue'"}}.dump() << "\n";
                std::cout.flush();
                continue;
            }

            if (!parse_queue(req["queue"], queue, err)) {
                std::cout << json{{"error", err}}.dump() << "\n";
                std::cout.flush();
                continue;
            }

            // オプション
            bool no_fire = false;
            std::string weight_name = "build";
            beam::Configs beam_configs;

            if (req.contains("options")) {
                auto& opts = req["options"];
                if (opts.contains("no_fire") && opts["no_fire"].is_boolean()) {
                    no_fire = opts["no_fire"].get<bool>();
                }
                if (opts.contains("weights") && opts["weights"].is_string()) {
                    weight_name = opts["weights"].get<std::string>();
                }
                if (opts.contains("width") && opts["width"].is_number_integer()) {
                    beam_configs.width = std::max(1, opts["width"].get<int>());
                }
                if (opts.contains("depth") && opts["depth"].is_number_integer()) {
                    beam_configs.depth = std::max(1, opts["depth"].get<int>());
                }
            }

            // 重みプロファイル選択
            beam::eval::Weight w = default_weight;

            if (weights.count(weight_name)) {
                w = weights.at(weight_name);
            }
            else if (!weights.empty()) {
                w = weights.begin()->second;
            }

            // ビームサーチ実行
            auto t0 = std::chrono::high_resolution_clock::now();
            auto result = beam::search_multi(field, queue, w, beam_configs);
            auto t1 = std::chrono::high_resolution_clock::now();
            i32 elapsed_ms = (i32)std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();

            // 候補手のJSON化 (no_fire フィルタリング込み)
            json candidates = json::array();
            bool filtered_any = false;

            for (auto& c : result.candidates) {
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

            // no_fire で全除外された場合はフォールバック
            if (no_fire && candidates.empty() && filtered_any) {
                for (auto& c : result.candidates) {
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

        std::cout << response.dump() << "\n";
        std::cout.flush();
    }

    return 0;
}
