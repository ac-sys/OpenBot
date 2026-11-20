import {
  IconAlertTriangle,
  IconCloud,
  IconCoin,
  IconCpu,
  IconExternalLink,
  IconRefresh,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  modelCreditsQueryOptions,
  modelKeys,
  resetModelCreditsUsage,
  updateModelCreditsBudget,
} from "@/lib/models/queries";
import { cn } from "@/lib/utils";

function formatUsd(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

function isLocalModelId(modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  return /^(?:local-|ollama(?:_chat)?\/)/i.test(modelId.trim());
}

/**
 * Compact live credits pill rendered beside the chat composer's model picker.
 * Shows remaining online credits (or "Local · Free" when using Ollama) and opens an inline
 * dialog to inspect per-model token spend and set/reset the online credit balance without
 * leaving the conversation.
 */
export function ModelCreditsPill({
  activeModelId,
  className,
}: {
  activeModelId?: string | null;
  className?: string;
}) {
  const queryClient = useQueryClient();
  const credits = useQuery(modelCreditsQueryOptions());
  const [open, setOpen] = useState(false);
  const [budgetDraft, setBudgetDraft] = useState("");

  const saveBudget = useMutation({
    mutationFn: (value: number | null) => updateModelCreditsBudget(value),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: modelKeys.credits });
    },
  });

  const resetUsage = useMutation({
    mutationFn: () => resetModelCreditsUsage(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: modelKeys.credits });
    },
  });

  const data = credits.data;
  if (!data) return null;

  const online = data.online;
  const effectiveModel = activeModelId || data.systemModels.defaultChatModel;
  const usingLocal = isLocalModelId(effectiveModel);
  const hasAlert = Boolean(online.quotaAlert);
  const isLow =
    online.percentRemaining !== null && online.percentRemaining <= 20;

  let pillText: string;
  if (usingLocal) {
    pillText = "Local · Free";
  } else if (online.remainingUsd !== null) {
    pillText = `${formatUsd(online.remainingUsd)} left`;
  } else if (online.totalSpendUsd > 0) {
    pillText = `${formatUsd(online.totalSpendUsd)} spent`;
  } else {
    pillText = "Credits";
  }

  const tooltipText = usingLocal
    ? "Running locally on Ollama (free). Click to view online model credits."
    : online.remainingUsd !== null
      ? `${formatUsd(online.remainingUsd)} remaining of ${formatUsd(online.budgetUsd ?? 0)} (${online.percentRemaining ?? 0}%). Click to view or update balance.`
      : `${formatUsd(online.totalSpendUsd)} estimated online spend (${formatTokens(online.totalTokens)} tokens). Click to set your online credit balance.`;

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={`Online model credits: ${pillText}`}
              className={cn(
                "h-8 shrink-0 gap-1.5 px-2 font-normal text-xs",
                hasAlert || isLow
                  ? "text-destructive hover:text-destructive"
                  : "text-muted-foreground",
                className,
              )}
              data-slot="composer-credits"
              onClick={() => {
                setBudgetDraft(
                  online.budgetUsd !== null ? String(online.budgetUsd) : "",
                );
                void credits.refetch();
                setOpen(true);
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              {hasAlert ? (
                <IconAlertTriangle aria-hidden className="size-3.5 shrink-0" />
              ) : usingLocal ? (
                <IconCpu aria-hidden className="size-3.5 shrink-0" />
              ) : (
                <IconCoin aria-hidden className="size-3.5 shrink-0" />
              )}
              <span>{pillText}</span>
            </Button>
          }
        />
        <TooltipContent side="top">{tooltipText}</TooltipContent>
      </Tooltip>

      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Online Model Credits & Usage</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {online.quotaAlert ? (
              <div
                className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive text-sm"
                role="alert"
              >
                <IconAlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>{online.quotaAlert}</span>
              </div>
            ) : null}

            <div className="rounded-lg border p-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium text-base">
                  {online.remainingUsd !== null
                    ? `${formatUsd(online.remainingUsd)} remaining`
                    : `${formatUsd(online.totalSpendUsd)} estimated online spend`}
                </span>
                {online.budgetUsd !== null ? (
                  <span className="text-muted-foreground text-xs">
                    of {formatUsd(online.budgetUsd)} (
                    {online.percentRemaining ?? 0}%)
                  </span>
                ) : null}
              </div>
              <p className="mt-1 text-muted-foreground text-xs">
                Online: {online.totalRequests}{" "}
                {online.totalRequests === 1 ? "call" : "calls"} ·{" "}
                {formatTokens(online.totalTokens)} tokens (
                {formatUsd(online.totalSpendUsd)} spent) · Local Ollama:{" "}
                {data.local.totalRequests}{" "}
                {data.local.totalRequests === 1 ? "call" : "calls"} (free)
              </p>
              <p className="mt-1 text-muted-foreground text-xs">
                Chat: <strong>{effectiveModel}</strong> · Router:{" "}
                <strong>{data.systemModels.routerModel ?? "same"}</strong>
              </p>
            </div>

            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const trimmed = budgetDraft.trim();
                if (!trimmed) {
                  saveBudget.mutate(null);
                  return;
                }
                const parsed = Number(trimmed);
                if (Number.isFinite(parsed) && parsed >= 0) {
                  saveBudget.mutate(parsed);
                }
              }}
            >
              <Input
                aria-label="Online credit balance in USD"
                className="h-8 w-36"
                min="0"
                onChange={(e) => setBudgetDraft(e.target.value)}
                placeholder="Credit balance ($)"
                step="0.01"
                type="number"
                value={budgetDraft}
              />
              <Button disabled={saveBudget.isPending} size="sm" type="submit">
                {saveBudget.isPending ? "Saving…" : "Save balance"}
              </Button>
              <Button
                disabled={resetUsage.isPending}
                onClick={() => resetUsage.mutate()}
                size="sm"
                type="button"
                variant="outline"
              >
                <IconRefresh className="mr-1 size-3.5" />
                Reset meter
              </Button>
            </form>

            <p className="text-muted-foreground text-xs">
              {online.billingNote}
            </p>

            {data.byModel.length > 0 ? (
              <div className="rounded-lg border">
                {data.byModel.map((row, index) => (
                  <div key={row.model}>
                    {index > 0 ? <Separator /> : null}
                    <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                      <div className="flex min-w-0 items-center gap-2">
                        {row.tier === "local" ? (
                          <IconCpu className="size-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <IconCloud className="size-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {row.model}
                          </div>
                          <div className="text-muted-foreground">
                            {row.requests} calls ·{" "}
                            {formatTokens(row.promptTokens)} in /{" "}
                            {formatTokens(row.completionTokens)} out
                            {row.rateLimit?.remainingRequests !== undefined
                              ? ` · ${row.rateLimit.remainingRequests} req left`
                              : ""}
                          </div>
                        </div>
                      </div>
                      <span className="shrink-0 font-medium">
                        {row.tier === "local"
                          ? "Free"
                          : row.pricingKnown
                            ? formatUsd(row.estimatedCostUsd)
                            : "Metered"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </DialogBody>
          <DialogFooter className="flex flex-wrap items-center justify-between gap-2 sm:justify-between">
            <div className="flex items-center gap-3">
              <Link
                className="text-muted-foreground text-xs underline-offset-4 hover:text-foreground hover:underline"
                onClick={() => setOpen(false)}
                to="/admin/providers"
              >
                Open Providers & Usage
              </Link>
              {online.billingUrl ? (
                <a
                  className="inline-flex items-center gap-1 text-muted-foreground text-xs underline-offset-4 hover:text-foreground hover:underline"
                  href={online.billingUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  Google Billing
                  <IconExternalLink className="size-3" />
                </a>
              ) : null}
            </div>
            <Button
              onClick={() => setOpen(false)}
              size="sm"
              type="button"
              variant="secondary"
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
