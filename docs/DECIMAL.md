# Decimal / money

Money in JS is broken — `number` is a binary float, and `0.1 + 0.2` is not `0.3`. This page covers `f.decimal({ precision, scale })`, the per-dialect emit (Postgres NUMERIC, MSSQL MONEY, Mongo Decimal128, SQLite no-native), the integer-cents pattern, and the JS libraries (decimal.js, dinero) that bridge `Decimal` columns to safe arithmetic.

Related deep-dives:

* [MODEL.md](./MODEL.md#numbers--fint-ffloat-fbigint-fdecimal) — the numeric field family in context.
* [TYPES.md](./TYPES.md) — why `Row<typeof M>['price']` is `string`, not `number`.
* [AGGREGATIONS.md](./AGGREGATIONS.md#decimal-precision-in-_sum-and-_avg) — the precision story for `_sum` and `_avg`.
* [MONGO.md](./MONGO.md) — the Decimal128 round-trip on the Mongo driver.
* [RUNTIME-VALIDATION.md](./RUNTIME-VALIDATION.md) — pairing a zod schema with a `f.decimal()` field.

---

## Contents

* [Why decimal, not float](#why-decimal-not-float)
* [The forge surface](#the-forge-surface)
* [Per-dialect emit](#per-dialect-emit)
* [JS representations and their trade-offs](#js-representations-and-their-trade-offs)
* [Store as integer cents](#store-as-integer-cents)
* [Round-trip per driver](#round-trip-per-driver)
* [Arithmetic with `Decimal`](#arithmetic-with-decimal)
* [dinero.js / `@dinero/core` integration](#dinerojs--dinerocore-integration)
* [zod transforms at the boundary](#zod-transforms-at-the-boundary)
* [Display formatting](#display-formatting)
* [Tax and per-jurisdiction rounding](#tax-and-per-jurisdiction-rounding)
* [Currency conversion](#currency-conversion)
* [Performance — DECIMAL vs INTEGER](#performance--decimal-vs-integer)
* [Indexing decimals](#indexing-decimals)
* [Worked examples](#worked-examples)
* [Common mistakes](#common-mistakes)

---

## Why decimal, not float

JavaScript's `number` is an IEEE 754 binary double. Every decimal that
isn't a sum of inverse powers of two gets rounded to the nearest
binary fraction at parse time:

```ts
0.1 + 0.2;            // 0.30000000000000004
0.1 + 0.2 === 0.3;    // false
19.99 * 100;          // 1998.9999999999998
```

`0.1` is a repeating fraction in base 2 — the double holds a value
*near* `0.1`, not `0.1`. Same for `0.2`. Add them and the rounding
errors compound. For money this is fatal: a `19.99` line item × 100 lands
on `1998.9999…` instead of `1999`. Sum a million of those and the drift
is measurable in dollars. Rounding to two places is no rescue — the
rounded result depends on which side of the half-cent the float landed.

The fix is a *decimal* representation (base-10 radix). Two flavours:

1. **Arbitrary-precision decimal** — store the value as an integer
   coefficient + exponent (`1999 × 10⁻²`). No rounding on `+`, `−`, `×`
   until you ask for a fixed scale. PG `NUMERIC`, MySQL `DECIMAL`,
   MSSQL `DECIMAL`, DuckDB `DECIMAL`, BSON `Decimal128`.
2. **Fixed-point integer** — store the smallest unit (cents, satoshis)
   as a plain integer; never touch the decimal until display. `$19.99`
   is `1999`. The *integer-cents pattern*.

Both are correct. Both are also poorly served by JS `number` — a
decimal round-tripped to `number` re-introduces the bug at the JS
boundary. `f.decimal()` surfaces decimals as **strings** on `Row` and
accepts strings on `Create` / `Update`. You pick a decimal library on
top to do the math.

---

## The forge surface

There's one builder — `f.decimal({ precision, scale })`. There is no
`f.money`; it would be a dialect-leaky alias. Use `f.decimal` with the
precision and scale that fit your currency.

```ts
import { f, model } from 'forge-orm';

const Order = model('orders', {
  id:       f.id(),
  total:    f.decimal({ precision: 12, scale: 2 }),  // $9,999,999,999.99 max
  tax:      f.decimal({ precision: 12, scale: 2 }),
  currency: f.enumOf(['NGN', 'USD', 'EUR'] as const),
});
```

| Builder                                | TS type  | Optional? |
|----------------------------------------|----------|-----------|
| `f.decimal()`                          | `string` | no        |
| `f.decimal({ precision, scale })`      | `string` | no        |
| `f.decimal({ … }).optional()`          | `string \| null` on Row | yes |
| `f.decimal({ … }).default('0')`        | `string` | DB-side default |

Three things to know about the builder:

* **`precision` is total digits, `scale` is digits after the decimal
  point.** `precision: 12, scale: 2` means `9,999,999,999.99` is the
  largest value that fits. `precision: 18, scale: 4` is what you want for
  exchange rates or interest accruals.
* **Both options are optional.** Pass `f.decimal()` with no args and
  every dialect picks its default (PG `numeric` is unbounded; MySQL
  `DECIMAL` defaults to `(10, 0)` — *zero* decimals — which is almost
  never what you want; MSSQL defaults to `DECIMAL(18, 0)`).
* **The TS-side type is `string`.** Not `number`, not `bigint`, not a
  branded `Decimal`. The driver hands back a string; forge passes it
  through. See [JS representations](#js-representations-and-their-trade-offs)
  for what to do with that string.

There's no `f.money` builder for the same reason there's no `f.timestamp`
— "money" is a *use case*, not a wire type. PG and MySQL both have a
`MONEY` type but the units, locale, and rounding rules are baked in at the
server config, not the column. Locale-shifting a `MONEY` column between
two PG instances with different `lc_monetary` rewrites the value. forge
sticks with `NUMERIC` / `DECIMAL` so the column is portable.

If you want to emit a literal `MONEY` column (for compatibility with an
existing schema), use `f.text()` and the migration writer's escape hatch —
see [MIGRATIONS.md](./MIGRATIONS.md#native-column-types).

---

## Per-dialect emit

The DDL each dialect emits for `f.decimal({ precision: 12, scale: 2 })`,
sourced from `src/adapters/<dialect>/dialect.ts`:

| Dialect  | DDL                               | Max precision | Notes                                                                 |
|----------|-----------------------------------|---------------|------------------------------------------------------------------------|
| Postgres | `numeric(12, 2)`                  | unbounded     | Arbitrary precision; `numeric` with no `(p,s)` is unlimited.            |
| MySQL    | `DECIMAL(12, 2)`                  | 65 digits     | `DECIMAL` with no args defaults to `(10, 0)` — *no decimals*.          |
| SQLite   | `NUMERIC`                         | dynamic       | `precision` / `scale` are *parsed but ignored*. See below.             |
| DuckDB   | `DECIMAL(12, 2)`                  | 38 digits     | Stored as `HUGEINT × 10⁻scale`; arithmetic stays exact.                |
| MSSQL    | `DECIMAL(12, 2)`                  | 38 digits     | `DECIMAL` and `NUMERIC` are synonyms.                                  |
| Mongo    | (none — BSON `Decimal128`)        | 34 digits     | `Decimal128` is IEEE 754-2008 decimal; survives round-trip.            |

### Postgres — `numeric(p, s)` / `decimal(p, s)`

`numeric` and `decimal` are aliases. PG stores values as length-prefixed
base-10000 digits — arbitrary precision. `'0.1'::numeric + '0.2'::numeric`
is `'0.3'` on the wire. The `pg` driver returns `numeric` as a string by
default; forge surfaces it directly.

PG also ships a `MONEY` type — a 64-bit integer scaled by `lc_monetary`.
Don't use it; the locale binding rewrites values when servers' locales
differ. `numeric` is the right tool.

### MySQL — `DECIMAL(p, s)` and the `MONEY` myth

`DECIMAL(12, 2)` is exact, up to 65 digits. The trap is the default:
`DECIMAL` with no arguments is `DECIMAL(10, 0)` — *zero* decimals.
`f.decimal()` without args emits exactly that, so always pass them
explicitly.

MySQL and MariaDB have no `MONEY` type. The `mysql2` driver returns
`DECIMAL` as a string when `decimalNumbers: false` (the default, what
forge uses). If something upstream set `decimalNumbers: true`, undo it
— that re-introduces the float bug at the driver layer.

### SQLite — `NUMERIC` affinity, no native decimal

SQLite has *affinity*, not types. A `NUMERIC` column accepts any value
and stores it in whatever storage class fits — `'19.99'` lands as TEXT,
`1999` lands as INTEGER. There is no arbitrary-precision decimal in the
engine.

In practice:

* **Always pass strings on SQLite.** `'19.99'`, not `19.99`. The string
  survives; the number lands as REAL and brings the float bug back.
* **`SUM` / `AVG` / arithmetic promote to REAL.** Once the value crosses
  an operator (`+`, `*`, `SUM`) it becomes a double. Aggregate in app
  code or accept cent-level drift.
* **`precision`/`scale` are ignored at DDL.** The emitted DDL is just
  `NUMERIC`. Bound the column at the app layer (zod, or a manual CHECK).
* **`sqlite-decimal` loadable extension** adds true decimal arithmetic
  if your workload is money-heavy. forge doesn't load it by default;
  the integer-cents pattern below is the simpler answer.

### DuckDB — `DECIMAL(p, s)` with `HUGEINT` backing

DuckDB stores `DECIMAL(p, s)` as a 128-bit integer (`HUGEINT`) scaled by
`10⁻ˢ`. Max precision 38, arithmetic exact within budget — `SUM` of a
`DECIMAL(18, 4)` column over a billion rows fits without overflow.
`@duckdb/node-api` returns the value as `bigint × scale`; forge's coerce
layer converts to a string before it lands on `Row`.

### MSSQL — `DECIMAL(p, s)`, `MONEY`, `SMALLMONEY`

`DECIMAL` and `NUMERIC` are synonyms. Max precision 38. MSSQL has two
legacy money types: `MONEY` (8 bytes, 4 decimals, range ±9.22 × 10¹⁴)
and `SMALLMONEY` (4 bytes, 4 decimals, range ±2.15 × 10⁵). The `mssql`
package returns them as strings when precision > 15 and as numbers
otherwise — the second case brings the float bug back. forge emits
`DECIMAL` for `f.decimal()` and forces string on read so the shape is
uniform.

To coexist with an existing `MONEY` column, declare the field as
`f.decimal({ precision: 19, scale: 4 })` (same range) and ALTER the
column type at deploy. The Row shape stays string either way.

### Mongo — BSON `Decimal128`

Added in MongoDB 3.4. IEEE 754-2008 decimal128 — 34 significant digits,
exponent range −6143 to +6144. Exact arithmetic in `$sum`, `$avg`,
`$multiply`, `$add`. The `mongodb` driver hands back a
`bson.Decimal128`; forge's coerce layer (`src/adapters/mongo/coerce.ts`)
calls `.toString()` on read and re-wraps on write. You never see a raw
`Decimal128` on `Row`.

Aggregation pipelines preserve `Decimal128` end-to-end — Mongo is the
easiest place to do exact money math at the storage layer. See
[MONGO.md](./MONGO.md) for specifics.

---

## JS representations and their trade-offs

You're handed a `string` from the driver. You need to *do math* on it.
Four candidates:

* **`number`** — broken. `Number('19.99') * 0.075` looks fine for one
  line item; sum across a million orders and the cumulative drift is
  real money. The bug fires wherever `Number()` is called. Don't.
* **`bigint`** — exact integer arithmetic, no upper bound. Pair with the
  *integer-cents pattern* and money math is correct out of the box. The
  catch: no fractions (`1999n * 75n / 1000n` is `149n`, not `149.925n`,
  because integer division truncates) and no display formatting (you'll
  write a cents-to-string helper and rediscover negatives and
  thousands-separator edge cases). Right tool for exact integers in the
  smallest unit (satoshis, picoseconds, lamports) where you never
  divide. Wrong tool for tax math.
* **`string`** — what the driver hands you. Survives JSON, comparison
  (`'19.99' < '20.00'` is true for fixed-width strings), and storage
  round-trip. But arithmetic on strings isn't arithmetic. Use as the
  boundary value; parse to a decimal library before math.
* **`Decimal`** (`decimal.js` / `big.js` / `bignumber.js`) — the answer.

```ts
import Decimal from 'decimal.js';

const total = new Decimal('19.99');
const tax = total.mul('0.075');     // Decimal { '1.49925' }
const grand = total.add(tax);       // Decimal { '21.48925' }
grand.toFixed(2);                    // '21.49'
```

`decimal.js` is the de-facto pick: arbitrary precision, exact arithmetic,
no native deps. `big.js` is a smaller subset of the same API. Pick one
per project; mixing libraries means converting through string at every
boundary. Configure once at app boot:

```ts
Decimal.set({
  precision: 30,
  rounding: Decimal.ROUND_HALF_UP,
});
```

`ROUND_HALF_UP` rounds `.5` away from zero — what consumer pricing
usually expects (`$1.005` → `$1.01`). Some financial regulations require
`ROUND_HALF_EVEN` (banker's rounding) to avoid bias on long sums. Check
your jurisdiction.

| Type      | Math    | Fractions | Round-trip | Verdict for money            |
|-----------|---------|-----------|------------|------------------------------|
| `number`  | broken  | yes       | broken     | Never                        |
| `bigint`  | exact   | no        | safe       | Integer cents pattern only   |
| `string`  | none    | n/a       | safe       | Boundary value; not for math |
| `Decimal` | exact   | yes       | safe       | Default pick                 |

---

## Store as integer cents

The alternative to a `DECIMAL` column is the *integer-cents pattern*:
represent every money value as the smallest unit (cents for USD, kobo
for NGN, pence for GBP) stored as an integer. `$12.34` → `1234`.

```ts
const Order = model('orders', {
  id:           f.id(),
  total_cents:  f.bigint(),        // $12.34 stored as 1234n
  tax_cents:    f.bigint(),
  currency:     f.enumOf(['NGN', 'USD', 'EUR'] as const),
});
```

Trade-offs vs `f.decimal`:

| Property                  | `f.decimal({ p, s })`         | Integer cents (`f.bigint()`)         |
|---------------------------|--------------------------------|--------------------------------------|
| Wire format               | string                         | bigint (JS) / BIGINT (DB)            |
| Arithmetic                | needs decimal library          | native `bigint` operators            |
| Storage size              | precision-dependent            | always 8 bytes                       |
| Index size                | precision-dependent            | always 8 bytes (fastest)             |
| Fractions of a cent       | yes (scale ≥ 3)                | no (need a second column)            |
| Currency portability      | scale fixed per column         | scale fixed per currency             |
| Display formatting        | string slicing / library       | need divide + pad                    |
| Multi-currency in one col | yes (column is decimal)        | hard (different currencies have different scales) |
| Tax / interest math       | exact with decimal library     | exact only if no fractional cents    |
| Reporting export to CSV   | string is the value            | reporting code multiplies            |

The integer-cents pattern is *faster* (B-tree index on a `BIGINT` is
narrower than on a `DECIMAL(12, 2)`) and *harder to bug* (you cannot
accidentally pass a JS `number` and lose precision — the column is
`bigint`, the wire is `bigint`, the math is `bigint`). The cost is
display: you can't `console.log(order.total_cents)` and get a dollar
value, and reporting always multiplies by `10⁻scale`.

It pairs well with `dinero.js` (next section), which is *internally*
integer-cents.

A common hybrid: store as `f.bigint()` cents *and* expose a derived
column for SQL reporting.

```ts
const Order = model('orders', {
  id:          f.id(),
  total_cents: f.bigint(),
  // Generated column — read-only, computed at INSERT/UPDATE time on
  // PG/MySQL/SQLite/MSSQL/DuckDB. Mongo ignores (warned at push).
  total:       f.decimal({ precision: 12, scale: 2 })
                  .dbgenerated('CAST("total_cents" AS NUMERIC) / 100'),
});
```

`total` is read-only (forge strips it from `Create`/`Update` at runtime),
exposes a human-readable column to BI tools that don't speak cents, and
the underlying truth stays `bigint`. The trade-off is one extra column
and a per-row computation at write time — usually fine.

---

## Round-trip per driver

What you write, what you read, per dialect:

```ts
await db.order.create({ data: { total: '19.99' } });
const o = await db.order.findUnique({ where: { id } });
o!.total;
//  '19.99'   on PG / MySQL / DuckDB / MSSQL / Mongo
//  '19.99'   on SQLite  if you wrote a string
//  19.99     on SQLite  if you wrote a number (REAL — float bug back)
```

Behind the scenes: `pg` hands `numeric` back as a string; `mysql2`
returns `DECIMAL` as a string when `decimalNumbers: false` (forge's
default); `better-sqlite3` returns the storage class as-is — discipline
at the call site is what keeps the string shape consistent;
`@duckdb/node-api` returns `bigint × scale` and forge's coerce converts;
`mssql` returns string only when precision > 15, so forge forces string
on read for uniformity; `mongodb` hands back `bson.Decimal128` and forge
calls `.toString()`, re-wrapping on write.

The bypass: `$queryRaw` and the Mongo `db.$collection(...).aggregate()`
escape hatch talk to the driver directly. PG/MySQL hand you a `string`,
Mongo hands you a `bson.Decimal128`. You handle conversion at the call
site.

---

## Arithmetic with `Decimal`

The single rule for money math: **never use the JS operators (`+`, `-`,
`*`, `/`) on a decimal value.** Wrap to a `Decimal` first, do the math,
and convert back to string at the boundary.

```ts
import Decimal from 'decimal.js';

async function settleOrder(orderId: string) {
  const items = await db.orderItem.findMany({ where: { orderId } });

  let subtotal = new Decimal(0);
  for (const item of items) {
    const price = new Decimal(item.price);   // item.price is `string`
    const qty   = new Decimal(item.qty);
    subtotal = subtotal.add(price.mul(qty));
  }

  const taxRate = new Decimal('0.075');
  const tax = subtotal.mul(taxRate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const total = subtotal.add(tax);

  await db.order.update({
    where: { id: orderId },
    data: {
      subtotal: subtotal.toFixed(2),
      tax:      tax.toFixed(2),
      total:    total.toFixed(2),
    },
  });
}
```

Patterns worth knowing:

* `.toFixed(scale)` for storage, `.toString()` for math. Mixing them
  stores intermediate precision in a column that can't hold it — DB
  will reject (PG/MSSQL) or silently truncate (MySQL/SQLite).
* `.toDecimalPlaces(scale, rounding)` is explicit. Use it wherever a
  rounding decision happens. Implicit rounding inside `.mul()` / `.div()`
  follows the global config — clearer in review to be local.
* Sum first, round at the boundary. Per-item rounding compounds.
* Compare via `.eq` / `.lt` / `.gt` / `.cmp`. JS `===` is instance
  identity; `<` coerces to `number`.

---

## dinero.js / `@dinero/core` integration

`decimal.js` is a general decimal library. `dinero.js` is a *money*
library — currencies, minor units, locale formatting, and it refuses to
mix currencies in a single calculation.

```ts
import { dinero, add, multiply, toDecimal } from 'dinero.js';
import { USD } from '@dinero/currencies';

const total = dinero({ amount: 1999, currency: USD });   // $19.99
const tax   = multiply(total, { amount: 75, scale: 3 }); // × 0.075
const grand = add(total, tax);
toDecimal(grand);     // '21.4892'  (Dinero rounds toward storage scale)
```

Dinero is internally integer-cents — `amount: 1999` is the smallest
unit. It pairs with the integer-cents column pattern:

```ts
import { dinero, toSnapshot } from 'dinero.js';
import * as currencies from '@dinero/currencies';

type CurrencyCode = 'NGN' | 'USD' | 'EUR';

function toDinero(row: { total_cents: bigint; currency: CurrencyCode }) {
  return dinero({
    amount: Number(row.total_cents),   // safe up to ~9 × 10¹³
    currency: currencies[row.currency],
  });
}

function fromDinero(d: ReturnType<typeof dinero>) {
  const snap = toSnapshot(d);
  return { total_cents: BigInt(snap.amount) };
}
```

`Number(row.total_cents)` is safe up to `Number.MAX_SAFE_INTEGER / 100`
≈ `$90,071,992,547,409` — comfortably more than any consumer order. For
institutional finance, dinero's `bigint` calculator
(`@dinero/calculator-bigint`) keeps the integer shape end-to-end.

If you store money as `f.decimal({ p, s })` and want the dinero
discipline, convert at the boundary:

```ts
function decimalToDinero(value: string) {
  const cents = new Decimal(value).mul(100).round().toNumber();
  return dinero({ amount: cents, currency: USD });
}
```

Use `dinero.allocate(d, ratios)` for "split $10 three ways" — naive
division leaves a stray cent. `allocate([1, 1, 1])` gives back
`[334, 333, 333]` cents summing back to 1000; the remainder is
distributed left-to-right.

---

## zod transforms at the boundary

zod doesn't ship a decimal type, but the `string` surface gives a clean
integration point. Validate the wire shape, transform into a `Decimal`
for the business layer, format back to string for storage:

```ts
import { z } from 'zod';
import Decimal from 'decimal.js';

const moneyString = z.string().regex(/^-?\d+(\.\d+)?$/, 'invalid money')
  .refine(s => !new Decimal(s).isNaN(), 'unparseable')
  .transform(s => new Decimal(s));

const parsed = z.object({ total: moneyString, tax: moneyString })
  .parse({ total: '19.99', tax: '1.50' });

const grand = parsed.total.add(parsed.tax);
await db.order.create({ data: { total: grand.toFixed(2) } });
```

For the integer-cents column:

```ts
const moneyCents = z.string().regex(/^-?\d+(\.\d{1,2})?$/)
  .transform(s => BigInt(new Decimal(s).mul(100).round().toString()));
// '19.99' → 1999n
```

Pairs with the `InferCreate<typeof Model>` typing trick from
[TYPES.md — pattern (b)](./TYPES.md#b-zod-schema-paired-with-the-forge-model):

```ts
import type { InferCreate } from 'forge-orm';

const orderCreate = z.object({
  total:    moneyString.transform(d => d.toFixed(2)),
  tax:      moneyString.transform(d => d.toFixed(2)),
  currency: z.enum(['NGN', 'USD', 'EUR']),
}) satisfies z.ZodType<InferCreate<typeof Order>>;
```

`satisfies` proves the zod's *output* type matches `InferCreate` — drift
the model and the satisfies check breaks.

---

## Display formatting

Money is read by humans. Format at the boundary, in the user's locale.

```ts
new Decimal('1234.5').toFixed(2);          // '1234.50'  (fixed scale, no separators)

new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
  .format(1234.5);                          // '$1,234.50'

new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' })
  .format(1234.5);                          // '₦1,234.50'

new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' })
  .format(1234.5);                          // '1.234,50 €'
```

`Intl.NumberFormat.format()` takes a `number`. If you've kept money as
`Decimal` or `bigint`, don't undo it at the format step. Three routes:

* `total.toNumber()` at the very last step — safe if `total ≤
  Number.MAX_SAFE_INTEGER`.
* `formatToParts()` and stitch — when the value won't fit a double.
* A money library that knows about locale: `dinero.toFormat`, or
  `@formatjs/intl-numberformat` with its bigint extension.

---

## Tax and per-jurisdiction rounding

Three common rounding rules:

* **HALF_UP** — `.5` away from zero. `1.005` → `1.01`. Default for
  consumer-facing pricing.
* **HALF_EVEN** (banker's rounding) — `.5` to nearest even. `1.005` →
  `1.00`, `1.015` → `1.02`. Required by some financial regs (US GAAP,
  parts of EU VAT) to avoid statistical bias on long sums.
* **TRUNCATE** — drop the fraction. `1.009` → `1.00`. India GST input
  credits, JPY (no minor unit).

`decimal.js` exposes all three via `toDecimalPlaces(scale, mode)`:

```ts
type TaxRule = {
  rate:     string;
  rounding: 'HALF_UP' | 'HALF_EVEN' | 'TRUNCATE';
  scale:    number;
};

const taxRules: Record<string, TaxRule> = {
  'US-CA': { rate: '0.0725', rounding: 'HALF_EVEN', scale: 2 },
  'NG':    { rate: '0.075',  rounding: 'HALF_UP',   scale: 2 },
  'JP':    { rate: '0.10',   rounding: 'TRUNCATE',  scale: 0 },
};

function calculateTax(subtotal: string, rule: TaxRule): string {
  const modes = {
    HALF_UP:   Decimal.ROUND_HALF_UP,
    HALF_EVEN: Decimal.ROUND_HALF_EVEN,
    TRUNCATE:  Decimal.ROUND_DOWN,
  };
  return new Decimal(subtotal)
    .mul(rule.rate)
    .toDecimalPlaces(rule.scale, modes[rule.rounding])
    .toFixed(rule.scale);
}
```

For VAT-inclusive pricing (displayed price *includes* tax), the math
reverses: `subtotal = displayed / (1 + rate)`. Keep scale ≥ 4 during the
intermediate calc and round once at the end — back-calculating tax from
an already-rounded total introduces drift.

---

## Currency conversion

Two distinct concerns:

* **Frozen rate** — the rate at the moment of transaction. Stored
  alongside the order. Refunds reverse the *same* rate, not the current
  market rate.
* **Floating rate** — for display only at read time. Looked up from a
  feed; never stored on the order.

The frozen-rate pattern:

```ts
const Order = model('orders', {
  id:                f.id(),
  amount_settle:     f.decimal({ precision: 18, scale: 4 }),     // merchant's books
  currency_settle:   f.enumOf(['USD', 'EUR', 'GBP'] as const),
  amount_present:    f.decimal({ precision: 18, scale: 4 }),     // what the customer paid
  currency_present:  f.enumOf(['NGN', 'GHS', 'KES', 'USD', 'EUR', 'GBP'] as const),
  fx_rate:           f.decimal({ precision: 18, scale: 8 }),     // amount_present = amount_settle × fx_rate
  fx_rate_at:        f.dateTime(),
});
```

Two columns, not one. The merchant accounts in settlement currency; the
customer transacted in presentment currency. The FX rate is captured
once and frozen — reporting in either currency is exact.

`scale: 8` on the rate column covers everything: G10 pairs trade to 4
decimals, emerging-market to 6, crypto to 8.

For display-only conversion (showing the same USD price in EUR without
re-charging), look up the rate at render time. Don't store the converted
value — the rate moves, the stored value goes stale, and you've got two
truths to reconcile.

---

## Performance — DECIMAL vs INTEGER

`DECIMAL(p, s)` is *slower* than `INTEGER` / `BIGINT` everywhere except
Mongo:

* **Arithmetic.** `DECIMAL` uses multi-precision routines; `BIGINT` is
  one machine instruction. ~5-10× per op on PG, ~3× MSSQL, ~2× DuckDB.
* **`SUM` over millions of rows.** PG `numeric` aggregates serialise
  through the full numeric type for each partial sum; `bigint` partials
  fit in CPU registers. A rough order on PG 15 / 10M rows: `SUM` of
  `numeric(12, 2)` ≈ 2.3s, `SUM` of `bigint` cents ≈ 0.6s.
* **Index size.** B-tree leaf size determines random-read I/O. A
  `bigint` B-tree on 100M rows is ~1.4 GB; `numeric(12, 2)` is ~2.1 GB.
* **Mongo.** Decimal128 is 16 bytes; `Long` is 8. The gap is real but
  smaller — wire encoding dwarfs operator cost.

Integer-cents wins on raw throughput. The trade-off is flexibility — no
fractional cents without a second column, per-currency scale is fixed at
the schema level. Pick by workload:

* OLTP write-heavy + simple arithmetic → integer cents.
* Reporting-heavy with tax / interest / FX math → `f.decimal` + decimal
  library + explicit rounding at boundaries.
* Mongo-native → either; Decimal128 is fine.

---

## Indexing decimals

`f.decimal()` columns are indexable — default is B-tree, ordered range
scans work:

```ts
const Invoice = model('invoices', {
  id:     f.id(),
  amount: f.decimal({ precision: 12, scale: 2 }),
}, {
  indexes: [{ fields: { amount: 'asc' } }],
});

await db.invoice.findMany({
  where: { amount: { gte: '1000.00', lte: '5000.00' } },
});
```

Two gotchas:

* **SQLite NUMERIC affinity.** SQLite's B-tree compares by storage class,
  not declared affinity. A column with mixed string and number rows
  (passed `19.99` once and `'19.99'` once) orders all numbers before all
  strings — the index is correct but the comparison crosses types. Pass
  strings consistently.
* **Mongo Decimal128 ordering.** Sorts by numeric value, not
  lexicographic string — `sort({ amount: 1 })` is correct without extra
  work. The trap is *between* BSON types: a column that's sometimes
  `Decimal128` and sometimes `Long` sorts by BSON type code first. Use
  one type per column; forge enforces this on writes.

For cents columns (`f.bigint()`), the index is on a 64-bit integer — the
smallest, fastest B-tree shape on every dialect.

---

## Worked examples

### (a) Order amount as `Decimal(12, 2)` end-to-end

```ts
import { createDb, f, model, rel } from 'forge-orm';
import Decimal from 'decimal.js';

const Order = model('orders', {
  id:        f.id(),
  user_id:   f.objectId(),
  total:     f.decimal({ precision: 12, scale: 2 }),
  tax:       f.decimal({ precision: 12, scale: 2 }),
  currency:  f.enumOf(['NGN', 'USD', 'EUR'] as const),
  createdAt: f.dateTime().default('now'),
});

const schema = { order: Order } as const;
const db = await createDb({ url, schema });

// Write — strings on the boundary.
await db.order.create({
  data: {
    user_id:  'u_123',
    total:    '99.99',
    tax:      '7.50',
    currency: 'USD',
  },
});

// Read — strings on the row.
const o = await db.order.findFirst();
const total = new Decimal(o!.total);    // → Decimal('99.99')
const tax   = new Decimal(o!.tax);
const grand = total.add(tax);            // → Decimal('107.49')

console.log(grand.toFixed(2));           // '107.49'
```

### (b) Cents pattern with dinero

```ts
import { f, model } from 'forge-orm';
import { dinero, add, multiply, toSnapshot, toDecimal } from 'dinero.js';
import { USD } from '@dinero/currencies';

const Order = model('orders', {
  id:           f.id(),
  total_cents:  f.bigint(),
  tax_cents:    f.bigint(),
  currency:     f.enumOf(['USD', 'EUR', 'NGN'] as const),
});

// Wrap a row into Dinero objects at the boundary.
function asDinero(row: { total_cents: bigint; currency: 'USD' | 'EUR' | 'NGN' }) {
  return dinero({ amount: Number(row.total_cents), currency: USD });
}

// Compute total + tax with dinero — exact, currency-safe.
const o = await db.order.findFirst();
const total = asDinero(o!);                                    // $19.99
const tax   = multiply(total, { amount: 75, scale: 3 });        // × 0.075
const grand = add(total, tax);                                  // $21.49

const snap = toSnapshot(grand);
await db.order.update({
  where: { id: o!.id },
  data:  { total_cents: BigInt(snap.amount) },
});
```

### (c) Sum aggregation precision

```ts
const result = await db.order.aggregate({
  _sum: { total: true, tax: true },
});

// On PG / MySQL / DuckDB / MSSQL:
//   result._sum.total: string   — NUMERIC SUM stays exact
//   result._sum.tax:   string

// On SQLite:
//   result._sum.total: number   — promoted to REAL through SUM, drift possible

// On Mongo:
//   result._sum.total: string   — $sum on Decimal128 stays Decimal128

// Sum into a Decimal in app code for safe further math:
import Decimal from 'decimal.js';

const grand = new Decimal(result._sum.total!)
  .add(result._sum.tax!)
  .toFixed(2);
```

For SQLite money workloads where `_sum` precision matters, do the
aggregation in app code via cursor iteration, or store cents and
aggregate `BIGINT`:

```ts
// Money-safe sum on SQLite — pull cents and add as bigint.
const orders = await db.order.findMany({ select: { total_cents: true } });
const totalCents = orders.reduce((acc, o) => acc + o.total_cents, 0n);
```

### (d) Decimal128 on Mongo

```ts
const Order = model('orders', {
  id:    f.id(),
  total: f.decimal({ precision: 12, scale: 2 }),
});

const schema = { order: Order } as const;
const db = await createDb({ url: 'mongodb://localhost/shop', schema });

await db.order.create({ data: { total: '0.1' } });
await db.order.create({ data: { total: '0.2' } });

const all = await db.order.aggregate({ _sum: { total: true } });
all._sum.total;
//   '0.3'   — exact, because Mongo's $sum on Decimal128 stays Decimal128.
//            Compare to the JS '0.1 + 0.2 = 0.30000000000000004' bug.
```

`f.decimal()` on Mongo emits no DDL (Mongo is schemaless), but
forge wraps writes in `bson.Decimal128` and unwraps on read via
`.toString()`. The aggregation pipeline operators (`$sum`, `$avg`,
`$multiply`, `$add`) all preserve `Decimal128`. Mixing currencies in a
single `$sum` is a user-error; constrain with `$match` first.

---

## Common mistakes

* **Passing `number` to a `f.decimal` write.** `data: { total: 19.99 }`
  coerces to string at the driver layer on PG / MySQL / MSSQL — the
  float bug is already in the value. On SQLite it stores as REAL and
  the bug is permanent. Always pass strings.
* **`===` to compare Decimals.** `new Decimal('1') === new Decimal('1')`
  is `false` — different instances. Use `.eq(b)` or `.cmp(b) === 0`.
* **Forgetting `precision` and `scale`.** `f.decimal()` is `DECIMAL(10,
  0)` on MySQL — zero decimals. Always pass them.
* **Rounding each line item.** Sum first, round at the column. Per-item
  rounding compounds drift.
* **`toFixed` before more math.** `.toFixed` returns a string. Re-wrap
  to `new Decimal(...)` before the next op.
* **Mixing decimal libraries.** `decimal.js` and `bignumber.js` differ
  on rounding defaults. Pick one per project.
* **`decimalNumbers: true` on MySQL.** Whoever set it thought they were
  "fixing" the string-vs-number inconsistency. They re-broke precision.
  Audit your connection options.
* **FX rate at the wrong scale.** `scale: 4` for G10, `scale: 8` for
  emerging-market and crypto. `scale: 2` rounds `0.0012` to `0.00`.
* **Sum on SQLite without thinking.** `_sum` over `f.decimal()` on
  SQLite promotes to REAL. Store cents and sum bigints, or aggregate in
  app code.

---

## Where to go next

* **[MODEL.md — Numbers](./MODEL.md#numbers--fint-ffloat-fbigint-fdecimal)**
  — the field-type table in context.
* **[TYPES.md](./TYPES.md)** — why `Row<typeof M>['amount']` is `string`
  and how it threads through `InferCreate`.
* **[AGGREGATIONS.md — Decimal precision in `_sum` and `_avg`](./AGGREGATIONS.md#decimal-precision-in-_sum-and-_avg)**
  — the per-dialect aggregation specifics.
* **[MONGO.md](./MONGO.md)** — Decimal128 round-trip details and
  aggregation pipeline operators on decimal columns.
* **[RUNTIME-VALIDATION.md](./RUNTIME-VALIDATION.md)** — pairing zod
  with a `f.decimal()` field for end-to-end safe parsing.
