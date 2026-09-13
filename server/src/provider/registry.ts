import { executionSelectionSchema, ValidationError, type ExecutionSelection, type ProviderDescriptor } from "@agentique-console/core";
import type { AttemptExecutionRequest, ProviderAdapter } from "./adapter.ts";

export interface ProviderRegistration {
  adapter: ProviderAdapter;
  descriptor: ProviderDescriptor;
}

/** The only backend dispatch/catalog layer. Runtime consumers resolve using persisted identity. */
export class ProviderRegistry implements ProviderAdapter {
  private readonly entries = new Map<string, ProviderRegistration>();

  constructor(registrations: ProviderRegistration[], readonly defaults: ExecutionSelection, private readonly legacyProvider = "claude") {
    for (const entry of registrations) {
      if (entry.adapter.provider !== entry.descriptor.id || this.entries.has(entry.descriptor.id)) throw new TypeError("invalid or duplicate provider registration");
      this.entries.set(entry.descriptor.id, entry);
    }
    this.select(defaults, false);
  }

  get provider(): string { return this.defaults.provider; }
  get supportsContinuation(): boolean { return this.entry(this.provider).adapter.supportsContinuation; }
  catalog(): ProviderDescriptor[] { return structuredClone([...this.entries.values()].map((e) => e.descriptor)); }
  replace(next: ProviderRegistry): void {
    this.entries.clear();
    for (const [id, entry] of next.entries) this.entries.set(id, entry);
    Object.assign(this.defaults, next.defaults);
  }
  configureAvailability(readiness: (provider: string, model: string) => { configured: boolean; detail: string }): void {
    for (const entry of this.entries.values()) {
      for (const model of entry.descriptor.models) {
        const next = readiness(entry.descriptor.id, model.id);
        model.availability = model.availability?.detail === "Injected adapter" && !next.detail.includes("disabled") ? model.availability : next;
      }
      entry.descriptor.availability = { configured: entry.descriptor.models.some((m) => m.availability?.configured), detail: "Configure an enabled connection and credential in Settings." };
    }
  }
  describeModel(selection: { provider?: string; model: string }) {
    const model = this.entry(selection.provider ?? this.legacyProvider).descriptor.models.find((entry) => entry.id === selection.model);
    return model ? structuredClone(model) : undefined;
  }

  private entry(id: string): ProviderRegistration {
    const entry = this.entries.get(id);
    if (!entry) throw new ValidationError(`Unknown execution provider: ${id}`);
    return entry;
  }

  select(input: { provider?: string; model?: string }, requireConfigured = true): ExecutionSelection {
    const provider = input.provider ?? this.defaults.provider;
    const { descriptor } = this.entry(provider);
    const model = input.model ?? (provider === this.defaults.provider ? this.defaults.model : descriptor.defaultModel);
    const parsed = executionSelectionSchema.safeParse({ provider, model });
    if (!parsed.success) throw new ValidationError("Invalid provider/model selection");
    const configuredModel = descriptor.models.find((m) => m.id === model);
    if (!configuredModel) throw new ValidationError(`Model ${model} is not configured for ${descriptor.label}`);
    if (requireConfigured && !descriptor.availability.configured) throw new ValidationError(`${descriptor.label}: ${descriptor.availability.detail}`);
    if (requireConfigured && configuredModel.availability?.configured === false) throw new ValidationError(`${descriptor.label}: ${configuredModel.availability.detail}`);
    return parsed.data;
  }

  resolve(selection: { provider?: string; model: string }): ProviderAdapter {
    // Existing manifests belong to the original backend, even after an operator changes defaults.
    const provider = selection.provider ?? this.legacyProvider;
    // Catalog/readiness checks apply to new launches. A catalog edit cannot
    // rewrite a persisted model or prevent recovery/inspection of its run.
    // Revoked credentials or unavailable remote models become attempt failures.
    return this.entry(provider).adapter;
  }

  execute(request: AttemptExecutionRequest) {
    return this.resolve({ provider: this.defaults.provider, model: request.model }).execute(request);
  }
}
