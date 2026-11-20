import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export type ModelTier = "local" | "online";

export type RateLimitSnapshot = {
  remainingRequests?: number;
  limitRequests?: number;
  remainingTokens?: number;
  limitTokens?: number;
  resetRequests?: string;
  resetTokens?: string;
};

export type ModelUsageRecord = {
  model: string;
  tier: ModelTier;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  pricingKnown: boolean;
  lastUsedAt: string;
  lastStatus: number;
  lastError?: string;
  rateLimit?: RateLimitSnapshot;
};

export type ModelPricing = {
  /** USD per 1,000,000 input tokens. */
  inputPerMillion: number;
  /** USD per 1,000,000 output tokens. */
  outputPerMillion: number;
};

export type LiveProviderBalance = {
  provider: string;
  remainingUsd: number;
  totalCreditsUsd?: number;
  usedUsd?: number;
  checkedAt: string;
};

export type ModelCreditsSnapshot = {
  systemModels: {
    defaultChatModel: string;
    routerModel: string | null;
    gatewayUrl: string | null;
  };
  online: {
    budgetUsd: number | null;
    totalSpendUsd: number;
    remainingUsd: number | null;
    percentRemaining: number | null;
    totalTokens: number;
    totalRequests: number;
    quotaAlert: string | null;
    billingNote: string;
    billingUrl: string | null;
    liveBalance: LiveProviderBalance | null;
    resetAt: string | null;
    updatedAt: string | null;
  };
  local: {
    totalTokens: number;
    totalRequests: number;
  };
  byModel: ModelUsageRecord[];
};

type PersistedLedger = {
  version: 1;
  budgetUsd: number | null;
  resetAt: string | null;
  updatedAt: string | null;
  byModel: Record<string, ModelUsageRecord>;
};

const LOCAL_MODEL_PATTERNS = [
  /^local-/i,
  /^ollama(?:_chat)?\//i,
  /^(?:qwen|llama|mistral|phi|gemma|deepseek-r1|nomic)[\w.-]*:\w+/i,
];

/**
 * Reference USD pricing per 1M tokens for metered cloud models.
 * When a gateway returns an explicit positive `x-litellm-response-cost` header, that value wins.
 */
const MODEL_PRICING: Array<{ match: RegExp; pricing: ModelPricing }> = [
  {
    match: /gemini-3(?:\.\d+)?-flash-lite/i,
    pricing: { inputPerMillion: 0.1, outputPerMillion: 0.4 },
  },
  {
    match: /gemini-3(?:\.\d+)?-flash(?!-lite)/i,
    pricing: { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  },
  {
    match: /gemini-3(?:\.\d+)?-pro/i,
    pricing: { inputPerMillion: 2.0, outputPerMillion: 12.0 },
  },
  {
    match: /gemini-2\.5-flash-lite/i,
    pricing: { inputPerMillion: 0.1, outputPerMillion: 0.4 },
  },
  {
    match: /gemini-2\.5-flash/i,
    pricing: { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  },
  {
    match: /gemini-2\.5-pro/i,
    pricing: { inputPerMillion: 1.25, outputPerMillion: 10.0 },
  },
  {
    match: /groq-llama-70b|llama-3\.3-70b/i,
    pricing: { inputPerMillion: 0.59, outputPerMillion: 0.79 },
  },
  {
    match: /groq-qwen-32b|qwen3-32b/i,
    pricing: { inputPerMillion: 0.29, outputPerMillion: 0.59 },
  },
  {
    match: /gpt-4o-mini/i,
    pricing: { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  },
  {
    match: /gpt-4o|gpt-5/i,
    pricing: { inputPerMillion: 2.5, outputPerMillion: 10.0 },
  },
  {
    match: /claude-.*haiku/i,
    pricing: { inputPerMillion: 0.8, outputPerMillion: 4.0 },
  },
  {
    match: /claude-.*sonnet/i,
    pricing: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  },
  {
    match: /claude-.*opus/i,
    pricing: { inputPerMillion: 15.0, outputPerMillion: 75.0 },
  },
];

export function classifyModelTier(model: string): ModelTier {
  const normalized = model.trim();
  if (!normalized) return "online";
  return LOCAL_MODEL_PATTERNS.some((pattern) => pattern.test(normalized))
    ? "local"
    : "online";
}

export function pricingForModel(model: string): ModelPricing | null {
  if (classifyModelTier(model) === "local") {
    return { inputPerMillion: 0, outputPerMillion: 0 };
  }
  const bare = model.split("/").at(-1) ?? model;
  for (const entry of MODEL_PRICING) {
    if (entry.match.test(model) || entry.match.test(bare)) {
      return entry.pricing;
    }
  }
  return null;
}

export function estimateUsageCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  reportedCostUsd?: number | null,
): { costUsd: number; pricingKnown: boolean } {
  if (classifyModelTier(model) === "local") {
    return { costUsd: 0, pricingKnown: true };
  }
  if (
    typeof reportedCostUsd === "number" &&
    Number.isFinite(reportedCostUsd) &&
    reportedCostUsd > 0
  ) {
    return { costUsd: roundUsd(reportedCostUsd), pricingKnown: true };
  }
  const pricing = pricingForModel(model);
  if (!pricing) return { costUsd: 0, pricingKnown: false };
  const inputCost =
    (Math.max(0, promptTokens) / 1_000_000) * pricing.inputPerMillion;
  const outputCost =
    (Math.max(0, completionTokens) / 1_000_000) * pricing.outputPerMillion;
  return { costUsd: roundUsd(inputCost + outputCost), pricingKnown: true };
}

export function parseRateLimitHeaders(
  headers: Headers,
): RateLimitSnapshot | undefined {
  const remainingRequests = parseOptionalNumber(
    headers.get("x-ratelimit-remaining-requests"),
  );
  const limitRequests = parseOptionalNumber(
    headers.get("x-ratelimit-limit-requests"),
  );
  const remainingTokens = parseOptionalNumber(
    headers.get("x-ratelimit-remaining-tokens"),
  );
  const limitTokens = parseOptionalNumber(
    headers.get("x-ratelimit-limit-tokens"),
  );
  const resetRequests =
    headers.get("x-ratelimit-reset-requests")?.trim() || undefined;
  const resetTokens =
    headers.get("x-ratelimit-reset-tokens")?.trim() || undefined;

  if (
    remainingRequests === undefined &&
    limitRequests === undefined &&
    remainingTokens === undefined &&
    limitTokens === undefined &&
    resetRequests === undefined &&
    resetTokens === undefined
  ) {
    return undefined;
  }

  return {
    ...(remainingRequests !== undefined ? { remainingRequests } : {}),
    ...(limitRequests !== undefined ? { limitRequests } : {}),
    ...(remainingTokens !== undefined ? { remainingTokens } : {}),
    ...(limitTokens !== undefined ? { limitTokens } : {}),
    ...(resetRequests ? { resetRequests } : {}),
    ...(resetTokens ? { resetTokens } : {}),
  };
}

export function parseLiteLLMResponseCost(headers: Headers): number | null {
  const raw = headers.get("x-litellm-response-cost");
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function defaultLedgerPath(): string | null {
  const configured = process.env.OPENBOT_CREDITS_FILE?.trim();
  if (configured) return path.resolve(configured);
  if (
    process.env.NODE_ENV === "test" ||
    process.argv.some((arg) => /\.test\.[cm]?[jt]sx?$/i.test(arg))
  ) {
    return null;
  }
  const cwd = process.cwd();
  const base = path.basename(cwd).toLowerCase();
  const root =
    base === "server" || base === "app" ? path.resolve(cwd, "..") : cwd;
  return path.join(root, ".openbot-model-credits.json");
}

function parseEnvBudget(
  env: Record<string, string | undefined>,
): number | null {
  const raw =
    env.ONLINE_CREDIT_BUDGET_USD?.trim() ||
    env.GEMINI_CREDIT_BUDGET_USD?.trim() ||
    "";
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? roundUsd(parsed) : null;
}

export class ModelCreditsLedger {
  private readonly filePath: string | null;
  private loaded = false;
  private state: PersistedLedger = {
    version: 1,
    budgetUsd: null,
    resetAt: null,
    updatedAt: null,
    byModel: {},
  };

  constructor(filePath?: string | null) {
    this.filePath = filePath === undefined ? defaultLedgerPath() : filePath;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.filePath) return;
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedLedger>;
      if (parsed && typeof parsed === "object" && parsed.byModel) {
        this.state = {
          version: 1,
          budgetUsd:
            typeof parsed.budgetUsd === "number" &&
            Number.isFinite(parsed.budgetUsd)
              ? roundUsd(parsed.budgetUsd)
              : null,
          resetAt: typeof parsed.resetAt === "string" ? parsed.resetAt : null,
          updatedAt:
            typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
          byModel: parsed.byModel,
        };
      }
    } catch {
      // Missing or unreadable file starts with an empty ledger.
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    try {
      const dir = path.dirname(this.filePath);
      mkdirSync(dir, { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf8");
      renameSync(tmp, this.filePath);
    } catch {
      // Never break model execution if the local filesystem is read-only.
    }
  }

  recordUsage(input: {
    model: string;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    reportedCostUsd?: number | null;
    status?: number;
    rateLimit?: RateLimitSnapshot;
    errorMessage?: string;
    now?: Date;
  }): void {
    this.ensureLoaded();
    const model = input.model.trim() || "unknown";
    const tier = classifyModelTier(model);
    const promptTokens = Math.max(0, Math.round(input.promptTokens ?? 0));
    const completionTokens = Math.max(
      0,
      Math.round(input.completionTokens ?? 0),
    );
    const totalTokens = Math.max(
      promptTokens + completionTokens,
      Math.round(input.totalTokens ?? 0),
    );
    const { costUsd, pricingKnown } = estimateUsageCostUsd(
      model,
      promptTokens,
      completionTokens,
      input.reportedCostUsd,
    );
    const nowIso = (input.now ?? new Date()).toISOString();
    const status = input.status ?? 200;

    const existing = this.state.byModel[model];
    const next: ModelUsageRecord = {
      model,
      tier,
      requests: (existing?.requests ?? 0) + 1,
      promptTokens: (existing?.promptTokens ?? 0) + promptTokens,
      completionTokens: (existing?.completionTokens ?? 0) + completionTokens,
      totalTokens: (existing?.totalTokens ?? 0) + totalTokens,
      estimatedCostUsd: roundUsd((existing?.estimatedCostUsd ?? 0) + costUsd),
      pricingKnown: pricingKnown || (existing?.pricingKnown ?? false),
      lastUsedAt: nowIso,
      lastStatus: status,
      ...(input.errorMessage
        ? { lastError: input.errorMessage.slice(0, 240) }
        : status >= 200 && status < 300
          ? {}
          : existing?.lastError
            ? { lastError: existing.lastError }
            : {}),
      ...(input.rateLimit
        ? { rateLimit: input.rateLimit }
        : existing?.rateLimit
          ? { rateLimit: existing.rateLimit }
          : {}),
    };

    this.state.byModel[model] = next;
    this.state.updatedAt = nowIso;
    this.persist();
  }

  setBudgetUsd(budgetUsd: number | null, now: Date = new Date()): void {
    this.ensureLoaded();
    this.state.budgetUsd =
      budgetUsd === null ? null : roundUsd(Math.max(0, budgetUsd));
    this.state.updatedAt = now.toISOString();
    this.persist();
  }

  resetUsage(now: Date = new Date()): void {
    this.ensureLoaded();
    const iso = now.toISOString();
    this.state.byModel = {};
    this.state.resetAt = iso;
    this.state.updatedAt = iso;
    this.persist();
  }

  snapshot(
    env: Record<string, string | undefined> = process.env,
    overrides?: {
      defaultChatModel?: string;
      liveBalance?: LiveProviderBalance | null;
    },
  ): ModelCreditsSnapshot {
    this.ensureLoaded();
    const records = Object.values(this.state.byModel).sort((a, b) => {
      if (a.tier !== b.tier) return a.tier === "online" ? -1 : 1;
      if (b.estimatedCostUsd !== a.estimatedCostUsd) {
        return b.estimatedCostUsd - a.estimatedCostUsd;
      }
      return b.totalTokens - a.totalTokens;
    });

    let onlineSpend = 0;
    let onlineTokens = 0;
    let onlineRequests = 0;
    let localTokens = 0;
    let localRequests = 0;
    let quotaAlert: string | null = null;

    for (const record of records) {
      if (record.tier === "online") {
        onlineSpend += record.estimatedCostUsd;
        onlineTokens += record.totalTokens;
        onlineRequests += record.requests;
        if (
          !quotaAlert &&
          (record.lastStatus === 429 || record.lastStatus === 402)
        ) {
          quotaAlert = `${record.model} returned HTTP ${record.lastStatus}${record.lastError ? `: ${record.lastError}` : ""}`;
        }
      } else {
        localTokens += record.totalTokens;
        localRequests += record.requests;
      }
    }

    const totalSpendUsd = roundUsd(onlineSpend);
    const liveBalance = overrides?.liveBalance ?? null;
    const budgetUsd =
      liveBalance?.totalCreditsUsd ??
      this.state.budgetUsd ??
      parseEnvBudget(env);
    const remainingUsd =
      liveBalance !== null
        ? roundUsd(Math.max(0, liveBalance.remainingUsd))
        : budgetUsd !== null
          ? roundUsd(Math.max(0, budgetUsd - totalSpendUsd))
          : null;
    const percentRemaining =
      budgetUsd !== null && budgetUsd > 0 && remainingUsd !== null
        ? Math.max(
            0,
            Math.min(100, Math.round((remainingUsd / budgetUsd) * 100)),
          )
        : null;

    if (
      !quotaAlert &&
      remainingUsd !== null &&
      budgetUsd !== null &&
      budgetUsd > 0
    ) {
      if (remainingUsd <= 0) {
        quotaAlert = "Online credit budget depleted ($0.00 remaining).";
      } else if (percentRemaining !== null && percentRemaining <= 20) {
        quotaAlert = `Low online credits: $${remainingUsd.toFixed(2)} (${percentRemaining}%) remaining.`;
      }
    }

    const hasGemini = Boolean(env.GOOGLE_API_KEY?.trim());
    const hasOpenRouter =
      Boolean(env.OPENROUTER_API_KEY?.trim()) ||
      Boolean(env.OPENAI_BASE_URL?.toLowerCase().includes("openrouter.ai"));

    const billingUrl = hasOpenRouter
      ? "https://openrouter.ai/settings/credits"
      : hasGemini
        ? "https://aistudio.google.com/spend"
        : "https://platform.openai.com/settings/organization/billing/overview";

    const billingNote = liveBalance
      ? `Live balance read directly from ${liveBalance.provider}.`
      : hasGemini
        ? "Google Gemini API does not expose a live billing balance endpoint. Set your current credit budget below to track remaining balance automatically from real token usage."
        : "Set your current online credit budget below to track remaining balance automatically from real token usage.";

    return {
      systemModels: {
        defaultChatModel:
          overrides?.defaultChatModel ??
          env.BOT_MODEL?.trim() ??
          "gemini-3.5-flash-lite",
        routerModel: env.ROUTER_MODEL?.trim() || null,
        gatewayUrl: env.OPENAI_BASE_URL?.trim() || null,
      },
      online: {
        budgetUsd,
        totalSpendUsd,
        remainingUsd,
        percentRemaining,
        totalTokens: onlineTokens,
        totalRequests: onlineRequests,
        quotaAlert,
        billingNote,
        billingUrl,
        liveBalance,
        resetAt: this.state.resetAt,
        updatedAt: this.state.updatedAt,
      },
      local: {
        totalTokens: localTokens,
        totalRequests: localRequests,
      },
      byModel: records,
    };
  }
}

/**
 * Query live remaining credits from providers that expose an official credit balance API
 * (currently OpenRouter). Returns null for providers without a balance API (e.g. Google Gemini).
 */
export async function fetchLiveProviderBalance(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<LiveProviderBalance | null> {
  const openRouterKey =
    env.OPENROUTER_API_KEY?.trim() ||
    (env.OPENAI_BASE_URL?.toLowerCase().includes("openrouter.ai")
      ? env.OPENAI_API_KEY?.trim()
      : "");
  if (!openRouterKey) return null;

  try {
    const response = await fetchImpl("https://openrouter.ai/api/v1/credits", {
      headers: { Authorization: `Bearer ${openRouterKey}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      data?: { total_credits?: number; total_usage?: number };
    };
    const total = payload.data?.total_credits;
    const used = payload.data?.total_usage;
    if (typeof total !== "number" || typeof used !== "number") return null;
    return {
      provider: "OpenRouter",
      totalCreditsUsd: roundUsd(total),
      usedUsd: roundUsd(used),
      remainingUsd: roundUsd(Math.max(0, total - used)),
      checkedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function parseOptionalNumber(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export const modelCredits = new ModelCreditsLedger();
