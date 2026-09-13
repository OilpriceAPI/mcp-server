/**
 * Quote rendering — drive the symbol off the currency the API reported.
 *
 * Every renderer in this server used to special-case USD/EUR/GBP and default
 * everything else to "$". Measured against the live catalogue on 2026-09-13
 * (GET /v1/commodities, 604 codes), that fabricated a dollar sign on 129 of
 * them: ₩1948 became "$1948.00", a 591-rig count became "$591.00", a 4.95%
 * treasury yield became "$4.95", and 203.30 pence of UK gas became "£203.30"
 * — a 100x overstatement on a series a customer can query today.
 *
 * The failure mode is what makes it serious: the tool returns isError:false,
 * so the calling agent has no signal that the number is wrong and reports it
 * as fact. An unlabelled number is recoverable; a mislabelled one is not.
 *
 * Rules, in order:
 *   1. Minor-unit currencies (GBp = pence) render in their own minor unit.
 *      Intl treats currency codes case-insensitively, so "GBp" would resolve
 *      to GBP and print pounds — this table must be consulted first.
 *   2. Non-monetary quote "currencies" (COUNT, PERCENT, INDEX, CONTRACTS,
 *      THOUSANDS, BCF, MBBL) are quantities, not money, and get no symbol.
 *   3. ISO-shaped codes are formatted by Intl.NumberFormat, which knows the
 *      symbol for every real currency and disambiguates CAD/AUD/MXN/BRL from
 *      USD (CA$, A$, MX$, R$) instead of printing a bare "$".
 *   4. Anything else renders as a bare number carrying its code.
 */

/** Currencies the API quotes in a minor unit rather than the major unit. */
const MINOR_UNIT_CURRENCIES: Record<
  string,
  { suffix: string; major: string; perMajor: number }
> = {
  // UK natural gas settles in pence per therm. NATURAL_GAS_GBP is GBp today.
  GBp: { suffix: "p", major: "GBP", perMajor: 100 },
  // Same shape, kept explicit so a future series cannot fall through to Intl
  // and silently become the major unit.
  ZAc: { suffix: "c", major: "ZAR", perMajor: 100 },
  ILA: { suffix: "a", major: "ILS", perMajor: 100 },
  USc: { suffix: "¢", major: "USD", perMajor: 100 },
};

/**
 * Quote "currency" values that are not money. These come straight from
 * GET /v1/commodities; the counts are the number of catalogue codes using
 * each as of 2026-09-13.
 */
const NON_MONETARY: Record<string, { suffix?: string }> = {
  COUNT: {}, // 21 codes — rig counts, well counts
  PERCENT: { suffix: "%" }, // 4 codes — treasury yields, fed funds
  INDEX: {}, // 8 codes — DXY, VIX, CPI
  CONTRACTS: {}, // 11 codes — CFTC COT positions
  THOUSANDS: {}, // 1 code — US nonfarm payrolls
  BCF: {}, // 1 code — natural gas storage
  MBBL: {}, // 1 code — Cushing crude storage
};

/** Units that are a label for the quantity, not a denominator of a price. */
const NON_DENOMINATOR_UNITS = new Set([
  "index",
  "percent",
  "currency_pair",
  "spreads",
]);

export type QuoteKind =
  | { kind: "minor"; code: string }
  | { kind: "quantity"; code: string }
  | { kind: "money"; code: string }
  | { kind: "unknown"; code: string | null };

/** Decide what a quote's `currency` field actually denotes. */
export function classifyQuoteCurrency(
  currency: string | null | undefined,
): QuoteKind {
  const code = typeof currency === "string" ? currency.trim() : "";
  if (!code) return { kind: "unknown", code: null };
  if (MINOR_UNIT_CURRENCIES[code]) return { kind: "minor", code };
  if (NON_MONETARY[code.toUpperCase()]) {
    return { kind: "quantity", code: code.toUpperCase() };
  }
  if (
    /^[A-Za-z]{3}$/.test(code) &&
    intlFormat(1, code.toUpperCase()) !== null
  ) {
    return { kind: "money", code: code.toUpperCase() };
  }
  return { kind: "unknown", code };
}

function intlFormat(value: number, code: string): string | null {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      // Keep two decimals for every currency. Intl would drop JPY and KRW to
      // zero decimals, which loses real precision on a price feed.
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return null;
  }
}

function plain(value: number, minimumFractionDigits = 2): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits,
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * Render one amount in the currency the API reported.
 *
 * Never invents a symbol: an unrecognized currency renders as a bare number
 * carrying its code, and a missing currency renders as a bare number.
 */
export function formatQuoteAmount(
  value: number,
  currency: string | null | undefined,
): string {
  const classified = classifyQuoteCurrency(currency);

  switch (classified.kind) {
    case "minor": {
      const spec = MINOR_UNIT_CURRENCIES[classified.code];
      return `${plain(value)}${spec.suffix}`;
    }
    case "quantity": {
      const spec = NON_MONETARY[classified.code];
      // A count of 591 rigs is "591", not "591.00".
      return `${plain(value, 0)}${spec.suffix ?? ""}`;
    }
    case "money": {
      // classifyQuoteCurrency already proved Intl accepts this code.
      return intlFormat(value, classified.code) as string;
    }
    case "unknown":
      return classified.code
        ? `${plain(value)} ${classified.code}`
        : plain(value);
  }
}

/** Render a signed delta in the same terms as the amount it moved. */
export function formatQuoteDelta(
  delta: number,
  currency: string | null | undefined,
): string {
  const sign = delta >= 0 ? "+" : "-";
  return `${sign}${formatQuoteAmount(Math.abs(delta), currency)}`;
}

/**
 * Human-readable unit, preferring what the API reported over the local
 * COMMODITY_INFO table. Returns "" when there is no useful unit to show.
 */
export function describeUnit(
  apiUnit: string | null | undefined,
  fallback?: string | null,
): string {
  const raw = (apiUnit ?? fallback ?? "").trim();
  if (!raw || raw === "unit") return "";
  if (NON_DENOMINATOR_UNITS.has(raw.toLowerCase())) return "";
  return raw.replace(/_/g, " ");
}

/**
 * Render "<amount>/<unit>" for a price, or "<amount> <unit>" for a counted
 * quantity, or just "<amount>" when the unit adds nothing.
 */
export function formatQuote(
  value: number,
  currency: string | null | undefined,
  apiUnit?: string | null,
  fallbackUnit?: string | null,
): string {
  const amount = formatQuoteAmount(value, currency);
  const unit = describeUnit(apiUnit, fallbackUnit);
  if (!unit) return amount;

  // A count of rigs is "591 rigs", not "591/rigs"; a price is "$104.32/barrel".
  if (classifyQuoteCurrency(currency).kind === "quantity") {
    return `${amount} ${unit}`;
  }
  return `${amount}/${unit}`;
}
