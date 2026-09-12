/**
 * Supabase Edge Function — update-expenses
 *
 * Fetches current-month transaction data from Supabase for a fixed user,
 * computes per-category and overall budget summaries, then pushes the
 * result to a TRMNL custom-plugin webhook.
 *
 * Environment variables required:
 *   SUPABASE_URL                  — injected automatically by Supabase
 *   SUPABASE_SERVICE_ROLE_KEY     — injected automatically by Supabase
 *   TRMNL_EXPENSES_WEBHOOK_URL    — TRMNL custom plugin webhook URL
 *
 * To adjust category budgets, edit CATEGORY_BUDGETS below.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── Configuration ────────────────────────────────────────────────────────────

/** The only user whose data is displayed on this dashboard. */
const USER_ID = "d35f81df-e4f8-478c-a5c7-72e2db962639";

/**
 * Target budget per category for the current month (AUD).
 * Keys must match the `name` column in the `category` table exactly
 * (comparison is case-insensitive in the normalisation step below).
 * Add, remove, or change amounts freely — the total is derived automatically.
 */
const CATEGORY_BUDGETS: Record<string, number> = {
  "EAT OUT": 1500,
  "TRAFFIC": 800,
  "GROCERY": 800,
  "SHOPPING": 500,
  "LIQUOR": 200,
  "ENTERTAINMENT": 100,
  "UTILITIES": 400,
  "INSURANCE": 200,
  "SERVICES": 100,
  "RENT": 2427,
  "OTHERS": 173
};

/**
 * Income / non-expense category names to exclude from the spend calculation
 * entirely (matched case-insensitively). Transactions in these categories are
 * skipped and never counted toward any budget bucket, including OTHERS.
 */
const EXCLUDED_CATEGORIES = new Set(["salary", "bonus", "travel"]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Format a number as a two-decimal string with thousands separators, e.g.
 *  `2988.5` → "2,988.50". Implemented manually (not via toLocaleString) so the
 *  2-decimal output is guaranteed regardless of the runtime's ICU support. */
function fmt(n: number): string {
  const fixed = Math.abs(n).toFixed(2); // always "d.dd"
  const [intPart, decPart] = fixed.split(".");
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${withCommas}.${decPart}`;
}

/** Format a number as a signed two-decimal string with thousands separators,
 *  preserving a leading minus sign when negative. */
function fmtSigned(n: number): string {
  const sign = n < 0 ? "-" : "";
  const fixed = Math.abs(n).toFixed(2);
  const [intPart, decPart] = fixed.split(".");
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${withCommas}.${decPart}`;
}

/** Return the current-month date range using the same construction as the
 *  reference transaction function (start = `YYYY-MM-01`, end = last calendar
 *  day via `new Date(year, month, 0)`), avoiding UTC boundary drift.
 *  Also returns a human-readable label and the number of days remaining. */
function getMonthBounds(): {
  start: string;
  end: string;
  label: string;
  daysRemaining: number;
  monthPercent: number;
} {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 1-based, matches "YYYY-MM" parsing
  const monthStr = String(month).padStart(2, "0");

  const start = `${year}-${monthStr}-01`;
  const end = new Date(year, month, 0).toISOString().substring(0, 10);

  const daysInMonth = new Date(year, month, 0).getDate();

  return {
    start,
    end,
    label: now.toLocaleString("en-AU", { month: "long", year: "numeric" }),
    daysRemaining: daysInMonth - now.getDate(),
    monthPercent: Math.round((now.getDate() / daysInMonth) * 100),
  };
}

// Override via TRMNL_EXPENSES_WEBHOOK_URL env var if needed.
const TRMNL_WEBHOOK_URL =
  Deno.env.get("TRMNL_EXPENSES_WEBHOOK_URL") ??
  "https://trmnl.com/api/custom_plugins/98bd662a-e1ce-4a0c-85f6-b1eb94b336e3";

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (_req) => {
  try {
    const webhookUrl = TRMNL_WEBHOOK_URL;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { start, end, label: monthLabel, daysRemaining, monthPercent } = getMonthBounds();

    // ── 1. Fetch all categories for this user (active + inactive) ─────────────
    // We need every category name so salary/bonus can always be identified and
    // excluded, regardless of their active flag.
    const { data: dbCategories, error: catError } = await supabase
      .from("category")
      .select("id, name")
      .eq("user_id", USER_ID);

    if (catError) {
      throw new Error(`Category query failed: ${catError.message}`);
    }

    // ── 2. Fetch transactions for this user in the current month ──────────────
    const { data: transactions, error: txError } = await supabase
      .from("transaction")
      .select("amount, category")
      .eq("user_id", USER_ID)
      .gte("trx_date", start)
      .lte("trx_date", end);

    if (txError) {
      throw new Error(`Transaction query failed: ${txError.message}`);
    }

    // ── 3. Map DB category IDs to canonical budget keys ────────────────────
    // Category names are matched case-insensitively (aligning with the
    // reference transaction function). Any name not in CATEGORY_BUDGETS is
    // bucketed as OTHERS. Income categories (salary/bonus) are marked null so
    // their transactions can be skipped entirely.
    const budgetKeyByLower = new Map(
      Object.keys(CATEGORY_BUDGETS).map((key) => [key.toLowerCase(), key]),
    );
    const catIdToKey: Record<string, string | null> = {};
    for (const { id, name } of dbCategories ?? []) {
      const lower = name.trim().toLowerCase();
      catIdToKey[id] = EXCLUDED_CATEGORIES.has(lower)
        ? null
        : budgetKeyByLower.get(lower) ?? "OTHERS";
    }

    // ── 4. Aggregate spending by canonical budget key ─────────────────────────
    // total spent = sum of ALL expense transactions (salary/bonus excluded).
    const spentByKey: Record<string, number> = {};
    let totalSpent = 0;

    for (const tx of transactions ?? []) {
      const mapped = catIdToKey[tx.category as string];
      // Skip only income categories (salary/bonus), which map to null.
      if (mapped === null) continue;
      // Unknown / unmapped categories are still expenses → bucket into OTHERS.
      const key = mapped ?? "OTHERS";
      spentByKey[key] = (spentByKey[key] ?? 0) + (tx.amount as number);
      totalSpent += tx.amount as number;
    }

    // ── 5. Build per-category objects — CATEGORY_BUDGETS keys only ───────────
    // Insertion order of CATEGORY_BUDGETS defines the display sequence.
    const today = new Date().getDate();

    // Apply RENT rule to totalSpent: before the 20th treat RENT as 0,
    // from the 20th onward treat it as fully spent (budget amount).
    const rentActual = spentByKey["RENT"] ?? 0;
    const rentEffective = CATEGORY_BUDGETS["RENT"];
    totalSpent = totalSpent - rentActual + rentEffective;
    const categories = Object.entries(CATEGORY_BUDGETS).map(([name, budget]) => {
      const spent = spentByKey[name] ?? 0;
      const overBudget = spent > budget;
      const safeRatio = budget > 0 ? spent / budget : 1;
      // Per-category tick bar: 50 ticks, each = 2 % of that category's budget.
      // Clamped to [1, 50] so the marker is always visible.
      // RENT is always shown as fully paid (100%, 50 ticks).
      const isRent = name === "RENT";
      const spentTicks = isRent
        ? 50
        : Math.max(1, Math.min(50, Math.round(safeRatio * 50)));
      const pct = isRent
        ? 100
        : Math.round(safeRatio * 100);

      return {
        name,
        budget_fmt: fmt(budget),
        spent_fmt: fmt(spent),
        budget_left_fmt: fmtSigned(budget - spent),
        over_budget: overBudget,
        spent_ticks: spentTicks,
        pct,
      };
    });

    // ── 6. Compute overall summary ────────────────────────────────────────────
    // total budget  = sum of every allocated budget in CATEGORY_BUDGETS.
    // total spent   = sum of all expense transactions (computed above).
    // budget left   = total budget − total spent.
    const totalBudget = Object.values(CATEGORY_BUDGETS).reduce(
      (sum, v) => sum + v,
      0,
    );
    const moneyLeft = totalBudget - totalSpent;
    const percentSpent = Math.min(
      Math.round((totalSpent / totalBudget) * 100),
      100,
    );
    const percentLeft = Math.max(100 - percentSpent, 0);
    const percentSpentFmt = fmt(
      Math.min((totalSpent / totalBudget) * 100, 100),
    );

    const lastSync = new Date().toLocaleString("en-AU", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

    // ── 7. Build and push TRMNL payload ───────────────────────────────────────
    const payload = {
      merge_variables: {
        month_label: monthLabel,
        total_budget_fmt: fmt(totalBudget),
        total_spent_fmt: fmt(totalSpent),
        budget_left_fmt: fmtSigned(moneyLeft),
        money_left_fmt: fmtSigned(moneyLeft),
        budget_total_fmt: fmt(totalBudget),
        over_total_budget: moneyLeft <= 0,
        percent_spent: percentSpent,
        percent_spent_fmt: percentSpentFmt,
        percent_left: percentLeft,
        days_remaining: daysRemaining,
        month_percent: monthPercent,
        categories,
        last_sync: lastSync,
      },
    };

    const trmnlResp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!trmnlResp.ok) {
      const body = await trmnlResp.text();
      throw new Error(`TRMNL webhook HTTP ${trmnlResp.status}: ${body}`);
    }

    console.log(
      `[update-expenses] pushed — spent $${fmt(totalSpent)} / $${fmt(totalBudget)}, left $${fmt(moneyLeft)}`,
    );

    return new Response(
      JSON.stringify(payload),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[update-expenses] error:", err);
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
