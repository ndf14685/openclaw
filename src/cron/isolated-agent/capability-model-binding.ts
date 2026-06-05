import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { resolveAllowedModelRef } from "../../agents/model-selection-resolve.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export type CapabilityModelBindingResolution =
  | {
      ok: true;
      inputCapability: string;
      capabilitiesEnabled: boolean;
      binding: string;
      bindingResolved: string;
      provider: string;
      model: string;
      fallbackApplied: boolean;
      reason: string;
    }
  | {
      ok: false;
      inputCapability: string;
      capabilitiesEnabled: boolean;
      binding?: string;
      bindingResolved?: string;
      fallbackApplied: boolean;
      reason: string;
    };

export function normalizeCapabilityName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveCapabilityModelBinding(params: {
  cfg: OpenClawConfig;
  capability: string;
}): string | undefined {
  if (params.cfg.capabilities_enabled !== true) {
    return undefined;
  }
  const binding = params.cfg.capabilities?.bindings?.[params.capability];
  if (typeof binding === "string") {
    const trimmed = binding.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (!binding || typeof binding !== "object") {
    return undefined;
  }
  const model = typeof binding.model === "string" ? binding.model.trim() : "";
  if (!model) {
    return undefined;
  }
  const provider = typeof binding.provider === "string" ? binding.provider.trim() : "";
  return provider && !model.includes("/") ? `${provider}/${model}` : model;
}

export function explainCapabilityModelBinding(params: {
  cfg: OpenClawConfig;
  cfgWithAgentDefaults: OpenClawConfig;
  catalog: ModelCatalogEntry[];
  capability: string;
  resolvedDefault: { provider: string; model: string };
}): CapabilityModelBindingResolution {
  const inputCapability = params.capability.trim();
  const capabilitiesEnabled = params.cfg.capabilities_enabled === true;
  if (!inputCapability) {
    return {
      ok: false,
      inputCapability,
      capabilitiesEnabled,
      fallbackApplied: false,
      reason: "capability vacia: se conserva la resolucion existente",
    };
  }
  if (!capabilitiesEnabled) {
    return {
      ok: false,
      inputCapability,
      capabilitiesEnabled,
      fallbackApplied: false,
      reason: "capabilities_enabled no esta en true: capability ignorada",
    };
  }

  const bindingResolved = resolveCapabilityModelBinding({
    cfg: params.cfg,
    capability: inputCapability,
  });
  if (!bindingResolved) {
    return {
      ok: false,
      inputCapability,
      capabilitiesEnabled,
      fallbackApplied: false,
      reason: "no hay binding valido para la capability",
    };
  }

  const resolvedCapability = resolveAllowedModelRef({
    cfg: params.cfgWithAgentDefaults,
    catalog: params.catalog,
    raw: bindingResolved,
    defaultProvider: params.resolvedDefault.provider,
    defaultModel: params.resolvedDefault.model,
  });
  if ("error" in resolvedCapability) {
    return {
      ok: false,
      inputCapability,
      capabilitiesEnabled,
      binding: bindingResolved,
      bindingResolved,
      fallbackApplied: false,
      reason: `binding rechazado por resolver de modelos: ${resolvedCapability.error}`,
    };
  }

  return {
    ok: true,
    inputCapability,
    capabilitiesEnabled,
    binding: bindingResolved,
    bindingResolved,
    provider: resolvedCapability.ref.provider,
    model: resolvedCapability.ref.model,
    fallbackApplied: false,
    reason: "binding de capability resuelto porque capabilities_enabled === true",
  };
}
