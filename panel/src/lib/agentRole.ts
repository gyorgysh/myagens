import type { Worker } from "../api.ts";
import type { TranslationKey } from "../i18n/en.ts";

type TFn = (k: TranslationKey) => string;

/**
 * Human-readable role / portfolio label for a worker, matching how the Crew tab
 * cards render it: leads get "<portfolio> Lead", assistants/specialists get
 * their portfolio or a generic role word. Kept in one place so the Chat view and
 * the Crew view stay in sync.
 */
export function roleLabel(w: Worker, t: TFn): string {
  if (w.role === "lead") {
    return w.portfolio ? `${w.portfolio} ${t("crew_role_lead")}` : t("crew_role_lead");
  }
  if (w.role === "assistant") {
    return w.portfolio || t("crew_role_assistant");
  }
  return w.portfolio || t("crew_role_specialist");
}
