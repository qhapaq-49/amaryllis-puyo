#pragma once

#include "../../../core/core.h"

namespace beam
{

namespace quiet
{

struct Result
{
    chain::Score chain = { 0, 0 };
    i32 x = 0;
    i32 key = 0;
    Field remain = Field();
};

std::pair<i8, i8> get_bound(u8 heights[6]);

template <typename Callback>
inline void generate_each(
    Field& field,
    i8 x_min,
    i8 x_max,
    i32 drop,
    Callback&& callback
)
{
    u8 heights[6];
    field.get_heights(heights);

    for (i8 x = x_min; x <= x_max; ++x) {
        // Finds the maximum amount of puyo blobs that can be drop
        i32 drop_max = std::min(drop, 12 - i32(heights[x]));

        if (drop_max <= 0) {
            continue;
        }

        // For every color
        for (u8 p = 0; p < cell::COUNT - 1; ++p) {
            auto copy = field;

            // Continues dropping puyo blobs until we trigger a chain
            for (i8 i = 0; i < drop_max; ++i) {
                copy.data[p].set_bit(x, heights[x] + i);

                if (copy.data[p].get_mask_group_4(x, heights[x]).get_count() >= 4) {
                    callback(x, p, i + 1);
                    break;
                }
            }
        }
    }
}

template <typename Callback>
inline void search_each(
    Field& field,
    i32 drop,
    Callback&& callback
)
{
    u8 heights[6];
    field.get_heights(heights);

    auto [x_min, x_max] = quiet::get_bound(heights);

    // Drops puyo until a chain is triggered for all columns and colors
    quiet::generate_each(
        field,
        x_min,
        x_max,
        drop,
        [&] (i8 x, i8 p, i8 need) {
            // Drops puyo
            auto plan = field;

            for (i32 i = 0; i < need; ++i) {
                plan.data[p].set_bit(x, heights[x] + i);
            }

            // Pops field
            auto pop = plan.pop();

            // Checks for callback
            if (pop.get_size() > 1) {
                auto chain = chain::get_score(pop);

                callback(Result {
                    .chain = chain::Score {
                        .count = chain.count,
                        .score = chain.score
                    },
                    .x = x,
                    .key = need,
                    .remain = plan
                });
            }
        }
    );
}

void search(
    Field& field,
    i32 drop,
    std::function<void(Result)> callback
);

void generate(
    Field& field,
    i8 x_min,
    i8 x_max,
    i32 drop,
    std::function<void(i8, i8, i8)> callback
);

};

};
