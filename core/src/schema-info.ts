import { z } from "zod";

/**
 * The single-row identity of a database created by the baseline migration.
 * It is not a domain object; the database-open guard compares it before
 * running any migration.
 */
export const SCHEMA_APPLICATION = "agentique-console";
export const SCHEMA_NAME = "orchestration-core";
export const SCHEMA_VERSION = 1;

export interface SchemaInfo {
  application: typeof SCHEMA_APPLICATION;
  schema: typeof SCHEMA_NAME;
  version: number;
}

export const schemaInfoSchema = z.strictObject({
  application: z.literal(SCHEMA_APPLICATION),
  schema: z.literal(SCHEMA_NAME),
  version: z.number().int().min(1),
});

export const EXPECTED_SCHEMA_INFO: SchemaInfo = {
  application: SCHEMA_APPLICATION,
  schema: SCHEMA_NAME,
  version: SCHEMA_VERSION,
};
