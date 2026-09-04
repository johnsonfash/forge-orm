# 10 · Recipe / BOM with sub-recipes

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/johnsonfash/forge-orm-examples/tree/main/10-recipe-bom)

Recursive cost rollup. A parent recipe (sourdough loaf) consumes a sub-recipe (starter) which has its own raw ingredients. Same pattern serves food, cosmetics, manufacturing, auto repair, candle-making.

## What this shows

- Self-referential composition through `componentSku` (no recursive FK required)
- Cycle detection via a `seen` Set during rollup
- Wastage % applied per line
- Yield normalization (cost per gram)

The model is small enough to inline in any project — copy the two schemas and the `rollup()` function.
