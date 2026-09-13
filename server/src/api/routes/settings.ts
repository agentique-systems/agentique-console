import { connectionTestSchema, mcpTestSchema, settingsImportSchema, settingsResetSchema, settingsSaveSchema } from "@agentique-console/core";
import { parse, type RouteHandlers } from "./support.ts";

export const settingsRoutes: Pick<RouteHandlers, "settings" | "saveSettings" | "testConnection" | "testMcp" | "exportSettings" | "importSettings" | "resetSettings" | "interfaceSettings"> = {
  settings: (_request, ctx) => ctx.app.settings.view(),
  saveSettings: (request, ctx) => ctx.app.settings.save(parse(settingsSaveSchema, request.body, "settings")),
  testConnection: (request, ctx) => ctx.app.settings.test(parse(connectionTestSchema, request.body, "connection")),
  testMcp: (request, ctx) => ctx.app.settings.testMcp(parse(mcpTestSchema, request.body, "MCP discovery")),
  exportSettings: (_request, ctx) => ctx.app.settings.export(),
  importSettings: (request, ctx) => { const body = parse(settingsImportSchema, request.body, "settings import"); return ctx.app.settings.import(body.revision, body.document, body.acknowledgeExecutable === true); },
  resetSettings: (request, ctx) => { const body = parse(settingsResetSchema, request.body, "settings reset"); return ctx.app.settings.reset(body.revision, body.section); },
  interfaceSettings: (_request, ctx) => ctx.app.settings.general,
};
