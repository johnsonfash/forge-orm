// Drizzle table definitions for the comparison bench.
//
// Drizzle does NOT own these tables. forge DDL/migrate creates the physical
// users table; these defs only describe the existing columns so Drizzle can
// build queries against them. We never run drizzle-kit push/migrate here.
//
// Column types mirror what forge emits per dialect (see
// src/adapters/<dialect>/dialect.ts columnType()):
//   PG     : id/email/name/role TEXT, active BOOLEAN, *_at TIMESTAMPTZ
//   MySQL  : id VARCHAR(64), email/name/role VARCHAR, active TINYINT(1), *_at DATETIME(3)
//   SQLite : id/email/name/role TEXT, active INTEGER (0/1)

import { pgTable, text as pgText, boolean as pgBool, timestamp as pgTs } from "drizzle-orm/pg-core";
import { mysqlTable, varchar as myVarchar, boolean as myBool, datetime as myDatetime } from "drizzle-orm/mysql-core";
import { sqliteTable, text as sqliteText, integer as sqliteInt } from "drizzle-orm/sqlite-core";

export const pgUsers = pgTable("users", {
  id: pgText("id").primaryKey(),
  email: pgText("email").notNull(),
  name: pgText("name").notNull(),
  role: pgText("role").notNull(),
  active: pgBool("active").notNull(),
  created_at: pgTs("created_at", { withTimezone: true }).notNull(),
  updated_at: pgTs("updated_at", { withTimezone: true }).notNull(),
});

export const mysqlUsers = mysqlTable("users", {
  id: myVarchar("id", { length: 64 }).primaryKey(),
  email: myVarchar("email", { length: 255 }).notNull(),
  name: myVarchar("name", { length: 255 }).notNull(),
  role: myVarchar("role", { length: 64 }).notNull(),
  active: myBool("active").notNull(),
  created_at: myDatetime("created_at", { fsp: 3 }).notNull(),
  updated_at: myDatetime("updated_at", { fsp: 3 }).notNull(),
});

export const sqliteUsers = sqliteTable("users", {
  id: sqliteText("id").primaryKey(),
  email: sqliteText("email").notNull(),
  name: sqliteText("name").notNull(),
  role: sqliteText("role").notNull(),
  active: sqliteInt("active", { mode: "boolean" }).notNull(),
});
