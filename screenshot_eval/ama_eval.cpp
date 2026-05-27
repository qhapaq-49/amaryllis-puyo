#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

#include "../ai/ai.h"
#include "../lib/nlohmann/json.hpp"

using json = nlohmann::json;

namespace
{

struct EvalOptions
{
    i32 target_point = 70;
    i32 trigger = ai::TRIGGER;
    size_t width = 500;
    size_t depth = 24;
    bool stretch = true;
};

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

std::string search_type_to_string(search::Type type)
{
    switch (type) {
    case search::Type::BUILD:     return "BUILD";
    case search::Type::FREESTYLE: return "FREESTYLE";
    case search::Type::FAST:      return "FAST";
    case search::Type::AC:        return "AC";
    }
    return "BUILD";
}

i32 score_to_garbage(i32 score, i32 target_point, i32 bonus = 0)
{
    if (target_point <= 0) {
        return 0;
    }
    return std::max(0, score + bonus) / target_point;
}

bool parse_field(const json& rows, Field& out, std::string& err)
{
    if (!rows.is_array() || rows.size() != 13) {
        err = "field must be an array of exactly 13 strings";
        return false;
    }

    char c[13][7];
    for (int y = 0; y < 13; ++y) {
        if (!rows[y].is_string()) {
            err = "each field row must be a string";
            return false;
        }
        auto row = rows[y].get<std::string>();
        if (row.size() != 6) {
            err = "each field row must be exactly 6 characters";
            return false;
        }
        for (int x = 0; x < 6; ++x) {
            char ch = row[x];
            if (ch != 'R' && ch != 'Y' && ch != 'G' && ch != 'B' && ch != '#' && ch != '.') {
                err = std::string("invalid cell character: ") + ch;
                return false;
            }
            c[y][x] = ch;
        }
        c[y][6] = '\0';
    }
    out.from(c);
    return true;
}

bool parse_queue(const json& pairs, cell::Queue& out, std::string& err)
{
    if (!pairs.is_array() || pairs.size() < 2) {
        err = "queue must be an array of at least 2 pairs";
        return false;
    }
    for (auto& pair : pairs) {
        if (!pair.is_array() || pair.size() != 2 || !pair[0].is_string() || !pair[1].is_string()) {
            err = "each queue entry must be an array of 2 color strings";
            return false;
        }
        auto a = pair[0].get<std::string>();
        auto b = pair[1].get<std::string>();
        cell::Type ca = cell::from_char(a.empty() ? '.' : a[0]);
        cell::Type cb = cell::from_char(b.empty() ? '.' : b[0]);
        if (ca == cell::Type::NONE || ca == cell::Type::GARBAGE ||
            cb == cell::Type::NONE || cb == cell::Type::GARBAGE) {
            err = "invalid queue color: use R/Y/G/B only";
            return false;
        }
        out.push_back({ ca, cb });
    }
    return true;
}

bool parse_player(const json& src, gaze::Player& out, i32& visible_garbage, std::string& err)
{
    if (!src.is_object()) {
        err = "player must be an object";
        return false;
    }
    if (!parse_field(src["field"], out.field, err)) {
        return false;
    }
    if (!parse_queue(src["queue"], out.queue, err)) {
        return false;
    }
    visible_garbage = src.value("garbage", 0);
    out.all_clear = src.value("all_clear", false);
    out.bonus = src.value("bonus", 0);
    out.attack_chain = src.value("attack_chain", 0);
    out.attack_frame = src.value("attack_frame", 0);
    out.dropping = src.value("dropping", 0);
    return true;
}

search::Configs load_configs()
{
    search::Configs configs;
    std::ifstream f("config.json");
    if (!f.good()) {
        return configs;
    }

    json js;
    f >> js;
    try { if (js.contains("build")) from_json(js["build"], configs.build); } catch (...) {}
    try { if (js.contains("freestyle")) from_json(js["freestyle"], configs.freestyle); } catch (...) {}
    try { if (js.contains("fast")) from_json(js["fast"], configs.fast); } catch (...) {}
    try { if (js.contains("ac")) from_json(js["ac"], configs.ac); } catch (...) {}
    return configs;
}

json placement_json(const move::Placement& p)
{
    return {
        {"x", static_cast<int>(p.x)},
        {"r", direction_to_string(p.r)},
    };
}

json attack_json(const dfs::attack::Data& a, i32 target_point)
{
    Field result = a.result;
    return {
        {"chain_count", a.count},
        {"score", a.score},
        {"score_total", a.score_total},
        {"send", score_to_garbage(a.score, target_point)},
        {"send_total", score_to_garbage(a.score_total, target_point)},
        {"frame", a.frame},
        {"frame_real", a.frame_real},
        {"all_clear", a.all_clear},
        {"redundancy", a.redundancy == INT32_MAX ? nullptr : json(a.redundancy)},
        {"link", a.link},
        {"result_count", result.get_count()},
    };
}

bool action_matches(const ai::Action& action, const ai::Result& result)
{
    return action.placement.x == result.placement.x &&
           action.placement.r == result.placement.r &&
           action.attack.score == result.eval;
}

json action_json(const move::Placement& p, const dfs::attack::Data& a, i32 target_point);

void sort_actions_for_display(std::vector<ai::Action>& actions)
{
    std::sort(actions.begin(), actions.end(), [] (const ai::Action& a, const ai::Action& b) {
        if (a.attack.score_total != b.attack.score_total) return a.attack.score_total > b.attack.score_total;
        if (a.attack.score != b.attack.score) return a.attack.score > b.attack.score;
        if (a.attack.frame_real != b.attack.frame_real) return a.attack.frame_real < b.attack.frame_real;
        return a.attack.link > b.attack.link;
    });
}

json action_list_json(std::vector<ai::Action> actions, i32 target_point, const ai::Result* decision = nullptr, size_t limit = 3)
{
    sort_actions_for_display(actions);
    json top = json::array();
    for (size_t i = 0; i < std::min(limit, actions.size()); ++i) {
        top.push_back(action_json(actions[i].placement, actions[i].attack, target_point));
    }

    bool contains_decision = false;
    if (decision != nullptr) {
        for (const auto& action : actions) {
            if (action_matches(action, *decision)) {
                contains_decision = true;
                break;
            }
        }
    }

    return {
        {"count", actions.size()},
        {"best", actions.empty() ? json(nullptr) : action_json(actions.front().placement, actions.front().attack, target_point)},
        {"top", top},
        {"contains_ama_move", contains_decision},
    };
}

json action_json(const move::Placement& p, const dfs::attack::Data& a, i32 target_point)
{
    return {
        {"placement", placement_json(p)},
        {"attack", attack_json(a, target_point)},
    };
}

std::vector<std::pair<move::Placement, dfs::attack::Data>> collect_attacks(const dfs::attack::Result& attacks)
{
    std::vector<std::pair<move::Placement, dfs::attack::Data>> result;
    for (const auto& c : attacks.candidates) {
        if (c.attack_max.score_total > 0 || c.attack_max.score > 0) {
            result.push_back({ c.placement, c.attack_max });
        }
        for (const auto& a : c.attacks) {
            if (a.score_total > 0 || a.score > 0) result.push_back({ c.placement, a });
        }
        for (const auto& a : c.attacks_detect) {
            if (a.score_total > 0 || a.score > 0) result.push_back({ c.placement, a });
        }
    }
    std::sort(result.begin(), result.end(), [] (const auto& a, const auto& b) {
        if (a.second.score_total != b.second.score_total) return a.second.score_total > b.second.score_total;
        if (a.second.score != b.second.score) return a.second.score > b.second.score;
        return a.second.frame_real < b.second.frame_real;
    });
    return result;
}

json top_attacks_json(const dfs::attack::Result& attacks, i32 target_point, size_t limit = 5)
{
    auto collected = collect_attacks(attacks);
    json arr = json::array();
    for (size_t i = 0; i < std::min(limit, collected.size()); ++i) {
        arr.push_back(action_json(collected[i].first, collected[i].second, target_point));
    }
    return arr;
}

json gaze_json(const gaze::Data& g, i32 target_point)
{
    return {
        {"main", attack_json(g.main, target_point)},
        {"main_q", attack_json(g.main_q, target_point)},
        {"harass", attack_json(g.harass, target_point)},
        {"early", attack_json(g.early, target_point)},
        {"defence_1", attack_json(g.defence_1, target_point)},
        {"defence_2", attack_json(g.defence_2, target_point)},
    };
}

json field_json(Field& f)
{
    u8 heights[6];
    f.get_heights(heights);
    json hs = json::array();
    for (int i = 0; i < 6; ++i) hs.push_back(static_cast<int>(heights[i]));
    return {
        {"count", f.get_count()},
        {"garbage_count", f.data[static_cast<int>(cell::Type::GARBAGE)].get_count()},
        {"unburied_count", gaze::get_unburied_count(f)},
        {"heights", hs},
    };
}

json beam_build_json(beam::Result result, size_t limit = 3)
{
    std::sort(result.candidates.begin(), result.candidates.end(), [] (const beam::Candidate& a, const beam::Candidate& b) {
        return a.score > b.score;
    });

    json top = json::array();
    for (size_t i = 0; i < std::min(limit, result.candidates.size()); ++i) {
        const auto& c = result.candidates[i];
        top.push_back({
            {"placement", placement_json(c.placement)},
            {"score", c.score},
            {"ama_eval", static_cast<i32>(c.score) / static_cast<i32>(beam::BRANCH)},
        });
    }

    return {
        {"count", result.candidates.size()},
        {"best", result.candidates.empty() ? json(nullptr) : top.front()},
        {"top", top},
    };
}

json dfs_build_json(dfs::build::Result result, size_t limit = 3)
{
    std::sort(result.candidates.begin(), result.candidates.end(), [] (const dfs::build::Candidate& a, const dfs::build::Candidate& b) {
        if (a.eval.value != b.eval.value) return a.eval.value > b.eval.value;
        return a.eval_fast > b.eval_fast;
    });

    json top = json::array();
    for (size_t i = 0; i < std::min(limit, result.candidates.size()); ++i) {
        const auto& c = result.candidates[i];
        top.push_back({
            {"placement", placement_json(c.placement)},
            {"value", c.eval.value},
            {"q", c.eval.q},
            {"fast_value", c.eval_fast},
        });
    }

    return {
        {"count", result.candidates.size()},
        {"best", result.candidates.empty() ? json(nullptr) : top.front()},
        {"top", top},
    };
}

cell::Queue first_two_queue(const cell::Queue& queue)
{
    cell::Queue q;
    if (queue.size() >= 2) {
        q.push_back(queue[0]);
        q.push_back(queue[1]);
    }
    return q;
}

json build_quality_json(Field field, cell::Queue queue, const search::Result& bsearch, search::Configs configs)
{
    auto q2 = first_two_queue(queue);
    dfs::build::Result freestyle;
    dfs::build::Result fast;
    dfs::build::Result ac;

    if (q2.size() >= 2) {
        freestyle = bsearch.freestyle.candidates.empty() ? dfs::build::search(field, q2, configs.freestyle) : bsearch.freestyle;
        fast = bsearch.fast.candidates.empty() ? dfs::build::search(field, q2, configs.fast) : bsearch.fast;
        ac = bsearch.ac.candidates.empty() ? dfs::build::search(field, q2, configs.ac) : bsearch.ac;
    }

    return {
        {"beam_build", beam_build_json(bsearch.build)},
        {"freestyle_build", dfs_build_json(freestyle)},
        {"fast_build", dfs_build_json(fast)},
        {"all_clear_build", dfs_build_json(ac)},
    };
}

i32 attack_max_score_total(const dfs::attack::Result& attacks)
{
    i32 attack_max = 0;
    for (const auto& c : attacks.candidates) {
        attack_max = std::max(attack_max, c.attack_max.score_total);
    }
    return attack_max;
}

json incoming_diagnostics_json(
    gaze::Player self,
    gaze::Player enemy,
    dfs::attack::Result self_attacks,
    const gaze::Data& enemy_gaze,
    bool enemy_small_field,
    bool enemy_garbage_obstruct,
    i32 balance,
    i32 accept_limit,
    i32 resource_balance,
    i32 target_point,
    i32 trigger,
    const ai::Result& decision
)
{
    i32 enemy_attack = std::max(0, -balance);
    i32 field_count = self.field.get_count();
    i32 enemy_harass = score_to_garbage(enemy_gaze.harass.score, target_point);

    std::vector<ai::Action> all_clear_returns;
    if (enemy.all_clear && enemy.attack_chain <= 4) {
        for (const auto& c : self_attacks.candidates) {
            for (auto attack : c.attacks_ac) {
                if (attack.frame <= enemy.attack_frame) {
                    all_clear_returns.push_back({ c.placement, attack });
                }
            }
        }
    }

    std::vector<ai::Action> immediate_main_returns;
    for (const auto& c : self_attacks.candidates) {
        auto find = [&] (dfs::attack::Data attack) {
            if (attack.frame > enemy.attack_frame) return;
            if (score_to_garbage(attack.score, target_point, self.bonus) < enemy_attack) return;
            if (attack.score < 2100) return;
            immediate_main_returns.push_back({ c.placement, attack });
        };
        for (auto attack : c.attacks) find(attack);
        for (auto attack : c.attacks_detect) find(attack);
    }
    auto immediate_summary = action_list_json(immediate_main_returns, target_point, &decision);
    bool immediate_best_exists = !immediate_main_returns.empty();
    bool immediate_ama_condition =
        immediate_best_exists &&
        (immediate_summary["best"]["attack"]["score"].get<i32>() >= std::min(trigger, 85000) ||
         enemy_attack >= 90 ||
         enemy_small_field ||
         enemy_garbage_obstruct);

    std::vector<ai::Action> attacks_syncro;
    std::vector<ai::Action> attacks_main;
    std::vector<ai::Action> attacks_small;
    std::vector<ai::Action> attacks_desperate;

    auto classify_attack = [&] (const move::Placement& placement, dfs::attack::Data attack) {
        if (attack.frame > enemy.attack_frame) {
            return;
        }

        i32 attack_send = score_to_garbage(attack.score, target_point, self.bonus);

        if ((attack_send >= enemy_attack + 24 && attack.frame_real + attack.count * 2 <= enemy.attack_frame + 4) ||
            (attack_send >= enemy_attack + 18 && attack.frame_real + attack.count * 2 <= enemy.attack_frame + 3) ||
            (attack_send >= enemy_attack + 12 && attack.frame_real + attack.count * 2 <= enemy.attack_frame + 2)) {
            attacks_syncro.push_back({ placement, attack });
        }

        if (attack_send >= enemy_attack) {
            if (attack.result.get_count() < std::max(24, field_count / 2)) {
                attacks_main.push_back({ placement, attack });
                return;
            }

            if (attack_send >= enemy_harass + enemy_attack - 12 ||
                attack.frame_real + attack.count * 2 <= enemy.attack_frame + 2) {
                attack.redundancy = gaze::get_redundancy(attack.parent, attack.result);
                attacks_small.push_back({ placement, attack });
            }

            return;
        }

        if (attack_send >= enemy_attack - 6 &&
            attack.result.get_height(2) < 10 &&
            enemy_attack >= 12 &&
            enemy.attack_frame <= 4 &&
            enemy_harass < 6 &&
            !enemy_small_field &&
            !enemy_garbage_obstruct) {
            attack.redundancy = gaze::get_redundancy(attack.parent, attack.result);
            attack.redundancy += enemy_attack - attack_send;
            attacks_small.push_back({ placement, attack });
            return;
        }

        if (attack_send + 30 < enemy_attack) {
            return;
        }

        if (attack_send == 0 && field_count <= 42) {
            return;
        }

        attacks_desperate.push_back({ placement, attack });
    };

    for (const auto& c : self_attacks.candidates) {
        for (auto attack : c.attacks) classify_attack(c.placement, attack);
        for (auto attack : c.attacks_detect) classify_attack(c.placement, attack);
    }

    bool can_accept = balance < 0 && enemy_attack <= accept_limit && self.field.get_height(2) < 10;
    auto accept_build_type = search::Type::AC;
    if (enemy_attack < 6 && enemy.attack_frame >= 4) {
        accept_build_type = search::Type::BUILD;
    }

    auto fallback_build_type = search::Type::FAST;
    if (enemy.attack_frame > 10) {
        fallback_build_type = search::Type::FREESTYLE;
    }
    if (enemy_attack <= std::min(accept_limit, 6) && enemy.attack_frame <= 3) {
        fallback_build_type = search::Type::AC;
    }
    if (enemy_attack >= 50000 / target_point) {
        fallback_build_type = search::Type::BUILD;
    }
    if (enemy_attack >= 20000 / target_point && field_count >= 36) {
        fallback_build_type = search::Type::BUILD;
    }

    return {
        {"active", balance < 0},
        {"enemy_attack", enemy_attack},
        {"enemy_attack_frame", enemy.attack_frame},
        {"enemy_harass_send", enemy_harass},
        {"accept_limit", accept_limit},
        {"resource_balance", resource_balance},
        {"can_accept", can_accept},
        {"accept_build_type", search_type_to_string(accept_build_type)},
        {"fallback_build_type", search_type_to_string(fallback_build_type)},
        {"all_clear_return", action_list_json(all_clear_returns, target_point, &decision)},
        {"immediate_main_return", {
            {"ama_condition", immediate_ama_condition},
            {"candidates", immediate_summary},
        }},
        {"syncro_return", action_list_json(attacks_syncro, target_point, &decision)},
        {"main_return", action_list_json(attacks_main, target_point, &decision)},
        {"small_return", action_list_json(attacks_small, target_point, &decision)},
        {"desperate_return", action_list_json(attacks_desperate, target_point, &decision)},
    };
}

json offensive_diagnostics_json(
    gaze::Player self,
    gaze::Player enemy,
    dfs::attack::Result self_attacks,
    const gaze::Data& enemy_gaze,
    bool enemy_garbage_obstruct,
    i32 balance,
    i32 target_point,
    i32 trigger,
    const ai::Result& decision
)
{
    i32 field_count = self.field.get_count();
    i32 attack_max = attack_max_score_total(self_attacks);
    i32 enemy_harass = score_to_garbage(enemy_gaze.harass.score, target_point);
    i32 enemy_early_attack = score_to_garbage(enemy_gaze.early.score, target_point);
    i32 enemy_defense_1 = score_to_garbage(enemy_gaze.defence_1.score, target_point, enemy.bonus);
    i32 enemy_defense_2 = score_to_garbage(enemy_gaze.defence_2.score, target_point, enemy.bonus);

    u8 enemy_heights[6];
    enemy.field.get_heights(enemy_heights);

    std::vector<ai::Action> syncro_attacks;
    if (balance >= 0 && enemy.attack_frame > 0) {
        for (const auto& c : self_attacks.candidates) {
            auto classify = [&] (dfs::attack::Data attack) {
                if (attack.frame_real + attack.count * 2 > enemy.attack_frame + 4) return;
                i32 attack_send = score_to_garbage(attack.score, target_point, self.bonus);
                i32 attack_goal = std::min(12, (11 - i32(enemy_heights[2])) * 6);
                if (attack_send >= attack_goal) {
                    attack.redundancy = gaze::get_redundancy(attack.parent, attack.result);
                    syncro_attacks.push_back({ c.placement, attack });
                }
            };
            for (auto attack : c.attacks) classify(attack);
            for (auto attack : c.attacks_detect) classify(attack);
        }
    }

    i32 enemy_main = std::max(enemy_gaze.main.score, enemy_gaze.main_q.score) / target_point;
    i32 enemy_height_min = *std::min_element(enemy_heights, enemy_heights + 6);
    i32 attack_need = enemy_main + (12 - enemy_height_min) * 6 + enemy.all_clear * 30;
    std::vector<ai::Action> kill_attacks;
    if (enemy_garbage_obstruct) {
        for (const auto& c : self_attacks.candidates) {
            auto classify = [&] (dfs::attack::Data attack) {
                if (score_to_garbage(attack.score, target_point, self.bonus) >= attack_need) {
                    kill_attacks.push_back({ c.placement, attack });
                }
            };
            for (auto attack : c.attacks) classify(attack);
            for (auto attack : c.attacks_detect) classify(attack);
        }
    }

    bool field_side_enough =
        self.field.get_height(0) > 3 &&
        self.field.get_height(1) > 3 &&
        self.field.get_height(2) > 3;
    bool harass_eligible =
        ((field_side_enough && field_count >= 24 && field_count < 52) || self.all_clear) &&
        attack_max < std::min(trigger, 85000);

    std::vector<ai::Action> crush_attacks;
    std::vector<ai::Action> combo_attacks;
    if (harass_eligible) {
        bool combo_side_enough =
            self.field.get_height(0) > 4 &&
            self.field.get_height(1) > 4 &&
            self.field.get_height(2) > 4;

        for (const auto& c : self_attacks.candidates) {
            auto classify_crush = [&] (dfs::attack::Data attack) {
                if ((attack.score_total - attack.score) / target_point > 4) return;

                i32 attack_send = score_to_garbage(attack.score_total, target_point, self.bonus);
                i32 attack_send_height = (attack_send / 6) + ((attack_send % 6) >= 3);
                i32 attack_result_count = attack.result.get_count();

                if (!self.all_clear && (enemy_heights[2] + attack_send_height <= 8)) return;

                u8 heights[6];
                attack.result.get_heights(heights);

                if (!self.all_clear) {
                    if (attack_result_count < 24) return;
                    if (heights[0] < 4 || heights[1] < 4 || heights[2] < 4 ||
                        heights[3] < 3 || heights[4] < 3 || heights[5] < 3) {
                        return;
                    }
                }
                else if (enemy.all_clear && attack_result_count < 24) {
                    return;
                }

                if (attack_send < 6 || attack.count > 2) return;

                attack.redundancy = gaze::get_redundancy(attack.parent, attack.result);
                if (attack.redundancy > 4) return;

                if (attack.count == 2 && attack.score / target_point < 12) return;
                if (attack.count == 3 && attack.score / target_point <= 20) return;

                if (attack.count == 1 &&
                    attack_send >= score_to_garbage(enemy_gaze.defence_1.score, target_point, enemy.bonus)) {
                    crush_attacks.push_back({ c.placement, attack });
                    return;
                }
                if ((attack.count == 2 || attack.count == 3) &&
                    attack_send >= score_to_garbage(enemy_gaze.defence_2.score, target_point, enemy.bonus)) {
                    crush_attacks.push_back({ c.placement, attack });
                }
            };

            auto classify_combo = [&] (dfs::attack::Data attack) {
                if (attack.frame > 6) return;

                i32 attack_send_prompt = score_to_garbage(attack.score_total - attack.score, target_point, self.bonus);
                i32 attack_send_combo = score_to_garbage(attack.score, target_point);
                if (attack_send_prompt < 4 || attack_send_prompt > 16) return;
                if (attack_send_combo < 30) return;

                u8 heights[6];
                attack.result.get_heights(heights);
                if (heights[0] < 3 || heights[1] < 3 || heights[2] < 3 ||
                    heights[3] < 3 || heights[4] < 3 || heights[5] < 3) {
                    return;
                }

                attack.redundancy = gaze::get_redundancy(attack.parent, attack.result);
                if (attack.redundancy > 6) return;

                combo_attacks.push_back({ c.placement, attack });
            };

            for (auto attack : c.attacks) {
                classify_crush(attack);
                classify_combo(attack);
            }
            if (combo_side_enough) {
                for (auto attack : c.attacks_detect) classify_combo(attack);
            }
        }
    }

    auto crush_margin = [&] () -> json {
        if (crush_attacks.empty()) {
            return nullptr;
        }

        i32 best = INT32_MIN;
        for (const auto& action : crush_attacks) {
            i32 send = score_to_garbage(action.attack.score_total, target_point, self.bonus);
            i32 defense = action.attack.count == 1 ? enemy_defense_1 : enemy_defense_2;
            best = std::max(best, send - defense);
        }
        return best;
    };

    auto neutral_build_type = search::Type::BUILD;
    bool keep_form = true;
    if (enemy_garbage_obstruct) {
        neutral_build_type = search::Type::FAST;
        keep_form = false;
    }
    if (gaze::is_small_field(self.field, enemy.field)) {
        neutral_build_type = search::Type::AC;
        keep_form = false;
    }
    if (enemy.all_clear) {
        neutral_build_type = search::Type::AC;
        keep_form = false;
    }

    return {
        {"active", balance >= 0},
        {"attack_max_score_total", attack_max},
        {"attack_max_send_total", score_to_garbage(attack_max, target_point, self.bonus)},
        {"enemy_harass_send", enemy_harass},
        {"enemy_early_send", enemy_early_attack},
        {"enemy_defense_1_send", enemy_defense_1},
        {"enemy_defense_2_send", enemy_defense_2},
        {"counter_attack_during_enemy_chain", action_list_json(syncro_attacks, target_point, &decision)},
        {"kill", {
            {"checked", enemy_garbage_obstruct},
            {"attack_need", enemy_garbage_obstruct ? json(attack_need) : json(nullptr)},
            {"candidates", action_list_json(kill_attacks, target_point, &decision)},
        }},
        {"harass", {
            {"eligible", harass_eligible},
            {"field_side_enough", field_side_enough},
            {"enemy_column_3_height", static_cast<int>(enemy_heights[2])},
            {"crush_margin", crush_margin()},
            {"crush", action_list_json(crush_attacks, target_point, &decision)},
            {"combo", action_list_json(combo_attacks, target_point, &decision)},
        }},
        {"neutral_build_type", search_type_to_string(neutral_build_type)},
        {"keep_form", keep_form},
    };
}

search::Result run_build_search(Field field, cell::Queue queue, search::Configs configs, const EvalOptions& options)
{
    search::Result result;
    beam::Configs beam_configs;
    beam_configs.width = options.width;
    beam_configs.depth = options.depth;
    beam_configs.trigger = options.trigger;
    beam_configs.stretch = options.stretch;

    if (queue.size() > 2) {
        result.build = beam::search(field, queue, configs.build, beam_configs);

        if (!result.build.candidates.empty()) {
            std::sort(
                result.build.candidates.begin(),
                result.build.candidates.end(),
                [&] (const beam::Candidate& a, const beam::Candidate& b) {
                    if (beam_configs.stretch) {
                        return a.score > b.score;
                    }

                    bool a_enough = a.score / beam::BRANCH >= beam_configs.trigger;
                    bool b_enough = b.score / beam::BRANCH >= beam_configs.trigger;

                    if (a_enough && b_enough) {
                        return a.score < b.score;
                    }

                    return a.score > b.score;
                }
            );
        }
    }
    else {
        result.build = beam::search_multi(field, queue, configs.build, beam_configs);
        result.freestyle = dfs::build::search(field, queue, configs.freestyle);
        result.fast = dfs::build::search(field, queue, configs.fast);
        result.ac = dfs::build::search(field, queue, configs.ac);
    }

    return result;
}

json diagnose_side(
    gaze::Player self,
    gaze::Player enemy,
    search::Configs configs,
    const EvalOptions& options
)
{
    auto start = std::chrono::high_resolution_clock::now();
    i32 target_point = options.target_point;
    i32 trigger = options.trigger;

    i32 balance = self.attack - enemy.attack;

    Field enemy_field_for_read = enemy.field;
    if (enemy.attack_frame > 0 && balance >= 3) {
        enemy_field_for_read.drop_garbage(balance);
    }
    if (enemy.dropping >= 3) {
        enemy_field_for_read.drop_garbage(balance);
    }

    auto self_attacks = dfs::attack::search(self.field, self.queue);
    auto enemy_attacks = dfs::attack::search(enemy_field_for_read, { enemy.queue[0], enemy.queue[1] });

    i32 enemy_delay = enemy.attack_frame + (enemy.dropping > 0) + (enemy.attack_frame > 0 && balance > 0);
    auto enemy_gaze = gaze::gaze(enemy_field_for_read, enemy_attacks, enemy_delay);

    bool enemy_small_field = gaze::is_small_field(enemy_field_for_read, self.field);
    bool enemy_garbage_obstruct = gaze::is_garbage_obstruct(
        enemy_field_for_read,
        chain::Score { .count = enemy_gaze.main.count, .score = enemy_gaze.main.score }
    );

    i32 accept_limit = gaze::get_accept_limit(self.field);
    i32 resource_balance = gaze::get_resource_balance(self.field, enemy_field_for_read);
    if (resource_balance <= -12) {
        accept_limit = std::max(accept_limit, (std::abs(resource_balance) / 6 + 1) * 6);
    }

    auto bsearch = run_build_search(self.field, self.queue, configs, options);
    auto decision = ai::think(self, enemy, bsearch, configs, target_point, ai::style::Data(), trigger, true);

    auto build_quality = build_quality_json(self.field, self.queue, bsearch, configs);
    auto incoming = incoming_diagnostics_json(
        self,
        enemy,
        self_attacks,
        enemy_gaze,
        enemy_small_field,
        enemy_garbage_obstruct,
        balance,
        accept_limit,
        resource_balance,
        target_point,
        trigger,
        decision
    );
    auto offense = offensive_diagnostics_json(
        self,
        enemy,
        self_attacks,
        enemy_gaze,
        enemy_garbage_obstruct,
        balance,
        target_point,
        trigger,
        decision
    );

    auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::high_resolution_clock::now() - start
    ).count();

    return {
        {"field", field_json(self.field)},
        {"pending", {
            {"self_attack", self.attack},
            {"enemy_attack", enemy.attack},
            {"balance", balance},
            {"incoming", std::max(0, -balance)},
            {"outgoing", std::max(0, balance)},
        }},
        {"enemy_read", {
            {"delay", enemy_delay},
            {"small_field", enemy_small_field},
            {"garbage_obstruct", enemy_garbage_obstruct},
            {"gaze", gaze_json(enemy_gaze, target_point)},
        }},
        {"defense", {
            {"accept_limit", accept_limit},
            {"resource_balance", resource_balance},
        }},
        {"strategy", {
            {"mode", balance < 0 ? "defense" : "offense_or_build"},
            {"build_quality", build_quality},
            {"incoming", incoming},
            {"offense", offense},
        }},
        {"self_attack_candidates", top_attacks_json(self_attacks, target_point)},
        {"enemy_attack_candidates", top_attacks_json(enemy_attacks, target_point, 3)},
        {"ama_move", {
            {"placement", placement_json(decision.placement)},
            {"eval", decision.eval},
            {"update_form", decision.update.form.has_value() ? json(decision.update.form.value()) : json(nullptr)},
            {"update_trigger", decision.update.trigger.has_value() ? json(decision.update.trigger.value()) : json(nullptr)},
        }},
        {"elapsed_ms", elapsed},
    };
}

json evaluate(const json& req)
{
    std::string err;
    gaze::Player p1, p2;
    i32 p1_visible_garbage = 0;
    i32 p2_visible_garbage = 0;

    if (!parse_player(req["p1"], p1, p1_visible_garbage, err)) {
        return {{"error", "p1: " + err}};
    }
    if (!parse_player(req["p2"], p2, p2_visible_garbage, err)) {
        return {{"error", "p2: " + err}};
    }

    // Visible garbage above a player is pending attack owned by the opponent.
    p1.attack = p2_visible_garbage;
    p2.attack = p1_visible_garbage;

    auto options = req.value("options", json::object());
    EvalOptions eval_options;
    eval_options.target_point = std::max<i32>(1, options.value("target_point", 70));
    eval_options.trigger = std::max<i32>(1, options.value("trigger", ai::TRIGGER));
    eval_options.width = static_cast<size_t>(std::clamp<i32>(options.value("width", 500), 1, 50000));
    eval_options.depth = static_cast<size_t>(std::clamp<i32>(options.value("depth", 24), 1, 80));
    eval_options.stretch = options.value("stretch", true);

    auto configs = load_configs();

    return {
        {"p1", diagnose_side(p1, p2, configs, eval_options)},
        {"p2", diagnose_side(p2, p1, configs, eval_options)},
        {"meta", {
            {"target_point", eval_options.target_point},
            {"trigger", eval_options.trigger},
            {"width", eval_options.width},
            {"depth", eval_options.depth},
            {"stretch", eval_options.stretch},
            {"note", "diagnostic values derived from ai::think inputs; not a calibrated win probability"},
        }},
    };
}

} // namespace

int main()
{
    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;
        try {
            std::cout << evaluate(json::parse(line)).dump() << "\n";
        }
        catch (const std::exception& e) {
            std::cout << json{{"error", e.what()}}.dump() << "\n";
        }
        std::cout.flush();
    }
    return 0;
}
