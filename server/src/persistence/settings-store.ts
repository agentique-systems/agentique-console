import type Database from "better-sqlite3";
import { ConflictError, type ConnectionTestResult, type SettingsValues } from "@agentique-console/core";

export interface StoredSecret { ciphertext: string; updatedAt: string }
export interface StoredSettings {
  version: 1;
  /** Only explicitly saved sections; deployment and built-in values remain inherited. */
  values: Partial<SettingsValues>;
  secrets: Record<string, StoredSecret>;
  tests: Record<string, { fingerprint: string; result: ConnectionTestResult }>;
}
const empty = (): StoredSettings => ({ version: 1, values: {}, secrets: {}, tests: {} });

/** Settings and encrypted credentials commit together on the application's existing SQLite connection. */
export class SettingsStore {
  constructor(private readonly sqlite: Database.Database) {}
  read(): { revision: number; document: StoredSettings } {
    const row = this.sqlite.prepare("SELECT revision, document FROM application_settings WHERE id = 1").get() as { revision: number; document: string } | undefined;
    if (!row) return { revision: 0, document: empty() };
    const document = JSON.parse(row.document) as StoredSettings;
    if (document.version !== 1) throw new Error("Unsupported settings storage version. Upgrade the application before opening this database.");
    return { revision: row.revision, document };
  }
  write(revision: number, document: StoredSettings): void {
    this.sqlite.transaction(() => {
      if (this.read().revision !== revision) throw new ConflictError("Settings changed in another window. Reload the latest settings before saving.");
      this.sqlite.prepare("INSERT INTO application_settings (id, revision, document) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, document = excluded.document").run(revision + 1, JSON.stringify(document));
    }).immediate();
  }
  activeDependencies(): { provider: string; count: number }[] {
    return this.sqlite.prepare("SELECT COALESCE(json_extract(execution, '$.provider'), 'claude') AS provider, COUNT(*) AS count FROM runs WHERE status NOT IN ('completed', 'failed', 'cancelled') GROUP BY provider").all() as { provider: string; count: number }[];
  }
}
