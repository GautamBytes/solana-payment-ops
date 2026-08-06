import {
  boolean,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const rpcProviders = pgTable("rpc_providers", {
  id: text("id").primaryKey(),
  cluster: text("cluster").notNull(),
  endpointEnv: text("endpoint_env").notNull(),
  endpointLabel: text("endpoint_label").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const watchTargets = pgTable(
  "watch_targets",
  {
    id: text("id").primaryKey(),
    providerId: text("provider_id")
      .notNull()
      .references(() => rpcProviders.id),
    cluster: text("cluster").notNull(),
    address: text("address").notNull(),
    cutoverSlot: numeric("cutover_slot", { precision: 20, scale: 0 }).notNull(),
    cutoverSignature: text("cutover_signature"),
    overlapSlots: numeric("overlap_slots", {
      precision: 20,
      scale: 0,
    }).notNull(),
    committedHeadSlot: numeric("committed_head_slot", {
      precision: 20,
      scale: 0,
    }),
    committedHeadSignature: text("committed_head_signature"),
    coverage: text("coverage").notNull().default("complete"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("watch_targets_identity")
      .on(table.providerId, table.cluster, table.address)
      .where(sql`${table.active}`),
  ],
);
