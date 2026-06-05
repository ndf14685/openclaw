import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronJob } from "../types.js";
import {
  normalizeCapabilityName,
  resolveCapabilityModelBinding,
} from "./capability-model-binding.js";
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  getModelRefStatus,
  loadModelCatalog,
  normalizeModelSelection,
  resolveAllowedModelRef,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
} from "./run-model-selection.runtime.js";

type CronSessionModelOverrides = {
  modelOverride?: string;
  providerOverride?: string;
  capabilityOverride?: string;
};

export type ResolveCronModelSelectionParams = {
  cfg: OpenClawConfig;
  cfgWithAgentDefaults: OpenClawConfig;
  agentConfigOverride?: {
    model?: unknown;
    subagents?: {
      model?: unknown;
    };
  };
  sessionEntry: CronSessionModelOverrides;
  payload: CronJob["payload"];
  isGmailHook: boolean;
  agentId?: string;
};

export type ResolveCronModelSelectionResult =
  | {
      ok: true;
      provider: string;
      model: string;
    }
  | {
      ok: false;
      error: string;
    };

function formatCronPayloadModelRejection(modelOverride: string, error: string): string {
  if (error.startsWith("model not allowed:")) {
    const modelRef = error.slice("model not allowed:".length).trim();
    return `cron payload.model '${modelOverride}' rejected by agents.defaults.models allowlist: ${modelRef}`;
  }
  return `cron payload.model '${modelOverride}' rejected: ${error}`;
}

async function applyCapabilitySelection(params: {
  cfg: OpenClawConfig;
  cfgWithAgentDefaults: OpenClawConfig;
  capability: string | undefined;
  resolvedDefault: { provider: string; model: string };
  loadCatalogOnce: () => Promise<Awaited<ReturnType<typeof loadModelCatalog>>>;
}): Promise<{ provider: string; model: string } | null> {
  if (!params.capability) {
    return null;
  }
  const modelBinding = resolveCapabilityModelBinding({
    cfg: params.cfg,
    capability: params.capability,
  });
  if (!modelBinding) {
    return null;
  }
  const resolvedCapability = resolveAllowedModelRef({
    cfg: params.cfgWithAgentDefaults,
    catalog: await params.loadCatalogOnce(),
    raw: modelBinding,
    defaultProvider: params.resolvedDefault.provider,
    defaultModel: params.resolvedDefault.model,
  });
  if ("error" in resolvedCapability) {
    return null;
  }
  return resolvedCapability.ref;
}

export async function resolveCronModelSelection(
  params: ResolveCronModelSelectionParams,
): Promise<ResolveCronModelSelectionResult> {
  const resolvedDefault = resolveConfiguredModelRef({
    cfg: params.cfgWithAgentDefaults,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  let provider = resolvedDefault.provider;
  let model = resolvedDefault.model;

  let catalog: Awaited<ReturnType<typeof loadModelCatalog>> | undefined;
  const loadCatalogOnce = async () => {
    if (!catalog) {
      catalog = await loadModelCatalog({ config: params.cfgWithAgentDefaults });
    }
    return catalog;
  };

  const subagentModelRaw =
    normalizeModelSelection(params.agentConfigOverride?.subagents?.model) ??
    normalizeModelSelection(params.agentConfigOverride?.model) ??
    normalizeModelSelection(params.cfg.agents?.defaults?.subagents?.model);
  if (subagentModelRaw) {
    const resolvedSubagent = resolveAllowedModelRef({
      cfg: params.cfgWithAgentDefaults,
      catalog: await loadCatalogOnce(),
      raw: subagentModelRaw,
      defaultProvider: resolvedDefault.provider,
      defaultModel: resolvedDefault.model,
    });
    if (!("error" in resolvedSubagent)) {
      provider = resolvedSubagent.ref.provider;
      model = resolvedSubagent.ref.model;
    }
  }

  let hooksGmailModelApplied = false;
  const hooksGmailModelRef = params.isGmailHook
    ? resolveHooksGmailModel({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
      })
    : null;
  if (hooksGmailModelRef) {
    const status = getModelRefStatus({
      cfg: params.cfg,
      catalog: await loadCatalogOnce(),
      ref: hooksGmailModelRef,
      defaultProvider: resolvedDefault.provider,
      defaultModel: resolvedDefault.model,
    });
    if (status.allowed) {
      provider = hooksGmailModelRef.provider;
      model = hooksGmailModelRef.model;
      hooksGmailModelApplied = true;
    }
  }

  const modelOverrideRaw = params.payload.kind === "agentTurn" ? params.payload.model : undefined;
  const modelOverride = typeof modelOverrideRaw === "string" ? modelOverrideRaw.trim() : undefined;
  if (modelOverride !== undefined && modelOverride.length > 0) {
    const resolvedOverride = resolveAllowedModelRef({
      cfg: params.cfgWithAgentDefaults,
      catalog: await loadCatalogOnce(),
      raw: modelOverride,
      defaultProvider: resolvedDefault.provider,
      defaultModel: resolvedDefault.model,
    });
    if ("error" in resolvedOverride) {
      return {
        ok: false,
        error: formatCronPayloadModelRejection(modelOverride, resolvedOverride.error),
      };
    }
    provider = resolvedOverride.ref.provider;
    model = resolvedOverride.ref.model;
  }

  let sessionModelOverrideApplied = false;
  if (!modelOverride && !hooksGmailModelApplied) {
    const sessionModelOverride = params.sessionEntry.modelOverride?.trim();
    if (sessionModelOverride) {
      const sessionProviderOverride =
        params.sessionEntry.providerOverride?.trim() || resolvedDefault.provider;
      const resolvedSessionOverride = resolveAllowedModelRef({
        cfg: params.cfgWithAgentDefaults,
        catalog: await loadCatalogOnce(),
        raw: `${sessionProviderOverride}/${sessionModelOverride}`,
        defaultProvider: resolvedDefault.provider,
        defaultModel: resolvedDefault.model,
      });
      if (!("error" in resolvedSessionOverride)) {
        provider = resolvedSessionOverride.ref.provider;
        model = resolvedSessionOverride.ref.model;
        sessionModelOverrideApplied = true;
      }
    }
  }

  if (!modelOverride && !sessionModelOverrideApplied) {
    const capability =
      params.payload.kind === "agentTurn"
        ? normalizeCapabilityName(params.payload.capability)
        : undefined;
    const capabilitySelection = await applyCapabilitySelection({
      cfg: params.cfg,
      cfgWithAgentDefaults: params.cfgWithAgentDefaults,
      capability,
      resolvedDefault,
      loadCatalogOnce,
    });
    if (capabilitySelection) {
      provider = capabilitySelection.provider;
      model = capabilitySelection.model;
    } else {
      const sessionCapabilitySelection = await applyCapabilitySelection({
        cfg: params.cfg,
        cfgWithAgentDefaults: params.cfgWithAgentDefaults,
        capability: normalizeCapabilityName(params.sessionEntry.capabilityOverride),
        resolvedDefault,
        loadCatalogOnce,
      });
      if (sessionCapabilitySelection) {
        provider = sessionCapabilitySelection.provider;
        model = sessionCapabilitySelection.model;
      }
    }
  }

  return { ok: true, provider, model };
}
