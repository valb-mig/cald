import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { PlanUsage, UsageWindow } from '../../system.ts';

type RawWindow = { utilization: number | null; resets_at: string | null } | null | undefined;

const toWindow = (w: RawWindow): UsageWindow | null => (w ? { utilization: w.utilization, resetsAt: w.resets_at } : null);

/**
 * Limites do plano (os mesmos do /usage). O método é experimental no SDK ("do not rely on it
 * yet"): se ele sumir ou mudar de formato, a chamada falha e o painel mostra "indisponível".
 */
export async function readPlanUsage(q: Query): Promise<PlanUsage> {
  const res = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
  const rl = res.rate_limits;
  const named = (name: string, w: RawWindow) => (w ? [{ name, ...toWindow(w)! }] : []);
  const models = [
    ...named('Opus', rl?.seven_day_opus),
    ...named('Sonnet', rl?.seven_day_sonnet),
    ...(rl?.model_scoped ?? []).map((m) => ({ name: m.display_name, utilization: m.utilization, resetsAt: m.resets_at })),
  ].filter((m) => m.utilization !== null);

  return {
    subscription: res.subscription_type,
    available: res.rate_limits_available,
    fiveHour: toWindow(rl?.five_hour),
    sevenDay: toWindow(rl?.seven_day),
    models,
    extraUsage: rl?.extra_usage?.is_enabled ? { utilization: rl.extra_usage.utilization } : null,
  };
}
