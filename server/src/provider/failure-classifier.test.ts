import { describe, expect, it } from "vitest";
import { classifyAssistantError, classifyFailureText, classifyProviderFailure, isCapacityFailure, isTransientFailure, isTransportFailure, PROVIDER_FAILURE_KINDS, sanitizeFailureMessage } from "./failure-classifier.ts";

describe("provider failure classification", () => {
  it("maps every SDK assistant error name to a closed kind with the right transience", () => {
    expect(classifyAssistantError("authentication_failed")).toBe("authentication");
    expect(classifyAssistantError("oauth_org_not_allowed")).toBe("authentication");
    expect(classifyAssistantError("billing_error")).toBe("billing");
    expect(classifyAssistantError("rate_limit")).toBe("rate_limited");
    expect(classifyAssistantError("overloaded")).toBe("overloaded");
    expect(classifyAssistantError("invalid_request")).toBe("invalid_request");
    expect(classifyAssistantError("model_not_found")).toBe("model_unavailable");
    expect(classifyAssistantError("server_error")).toBe("server_error");
    expect(classifyAssistantError("something_else")).toBe("unknown");
    for (const kind of ["transport", "rate_limited", "capacity", "overloaded", "server_error", "process_exit", "unknown"] as const) expect(isTransientFailure(kind), kind).toBe(true);
    for (const kind of ["authentication", "billing", "invalid_request", "model_unavailable", "max_turns"] as const) expect(isTransientFailure(kind), kind).toBe(false);
    expect(PROVIDER_FAILURE_KINDS).toHaveLength(12);
  });

  it("classifies prose: transport errors, capacity caps, rate limits, authentication, billing, models, overload, server errors, invalid requests", () => {
    expect(isTransportFailure("getaddrinfo ENOTIMP api.anthropic.com")).toBe(true);
    expect(isTransportFailure("API Error: 400 bad request")).toBe(true);
    expect(isTransportFailure("Connection error.")).toBe(true);
    expect(isTransportFailure("fine")).toBe(false);
    expect(isTransportFailure(null)).toBe(false);
    expect(isCapacityFailure("You've hit your session limit · resets 2:20am (Europe/Stockholm)")).toBe(true);
    expect(isCapacityFailure("weekly limit reached, resets Monday")).toBe(true);
    expect(isCapacityFailure(null)).toBe(false);
    expect(classifyFailureText("You've hit your usage limit · resets 3pm")).toBe("capacity");
    expect(classifyFailureText("API Error: 429 rate_limit_error")).toBe("rate_limited");
    expect(classifyFailureText("API Error: 401 authentication_error: invalid x-api-key")).toBe("authentication");
    expect(classifyFailureText("Your credit balance is too low")).toBe("billing");
    expect(classifyFailureText("model claude-nope does not exist")).toBe("model_unavailable");
    expect(classifyFailureText("API Error: 529 overloaded_error")).toBe("overloaded");
    expect(classifyFailureText("API Error: 500 internal server error")).toBe("server_error");
    expect(classifyFailureText("getaddrinfo ENOTFOUND api.anthropic.com")).toBe("transport");
    expect(classifyFailureText("prompt is too long: 250000 tokens")).toBe("invalid_request");
    expect(classifyFailureText("")).toBe("unknown");
    expect(classifyFailureText(null)).toBe("unknown");
  });

  it("sanitizes credentials and bounds the message; a named kind wins over prose, an unknown name defers to the prose", () => {
    expect(sanitizeFailureMessage("Bearer abcdefghijklmnopqrstuvwxyz0123 failed with sk-ant-api03-xxxxxxxxxxxx and token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U")).not.toMatch(/sk-ant-api03|abcdefghijklmnop|eyJ/);
    expect(sanitizeFailureMessage("x".repeat(2000)).length).toBeLessThanOrEqual(500);
    expect(sanitizeFailureMessage("   ")).toBe("provider failure");
    expect(classifyProviderFailure({ kind: "max_turns", text: "Reached max turns" })).toEqual({ kind: "max_turns", transient: false, message: "max_turns: Reached max turns" });
    expect(classifyProviderFailure({ error: "unknown", text: "API Error: 529 overloaded" }).kind).toBe("overloaded");
    expect(classifyProviderFailure({ error: "billing_error", text: "API Error: 529 overloaded" }).kind).toBe("billing");
    expect(classifyProviderFailure({}).kind).toBe("unknown");
  });
});
