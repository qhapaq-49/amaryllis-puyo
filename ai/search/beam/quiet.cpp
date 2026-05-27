#include "quiet.h"

namespace beam
{

namespace quiet
{

// Searches all the potential chain extensions of the field
void search(
    Field& field,
    i32 drop,
    std::function<void(Result)> callback
)
{
    quiet::search_each(field, drop, callback);
};

// Finds dropping positions that may trigger a chain
void generate(
    Field& field,
    i8 x_min,
    i8 x_max,
    i32 drop,
    std::function<void(i8, i8, i8)> callback
)
{
    quiet::generate_each(field, x_min, x_max, drop, callback);
};

// Gets the dropping bound
std::pair<i8, i8> get_bound(u8 heights[6])
{
    i8 x_min = 2;
    i8 x_max = 2;

    for (i8 x = 3; x < 6; ++x) {
        if (heights[x] > 11) {
            break;
        }

        x_max += 1;
    }

    for (i8 x = 1; x > -1; --x) {
        if (heights[x] > 11) {
            break;
        }

        x_min -= 1;
    }

    return { x_min, x_max };
};

};

};
