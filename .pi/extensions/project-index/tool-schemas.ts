import type { Static } from "typebox";
import { Type } from "typebox";

export const statusSchema = Type.Object({
  root: Type.Optional(Type.String({ description: "Optional root override." })),
});

export const refreshSchema = Type.Object({
  root: Type.Optional(Type.String({ description: "Optional root override." })),
  force: Type.Optional(Type.Boolean({ default: false })),
});

export const searchSchema = Type.Object({
  query: Type.Optional(
    Type.String({ description: "Project question/query to locate relevant sources." }),
  ),
  root: Type.Optional(
    Type.String({ description: "Root to query; host paths require access mode 4." }),
  ),
  maxFiles: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 12 })),
  includeTests: Type.Optional(Type.Boolean({ default: true })),
  includeDocs: Type.Optional(Type.Boolean({ default: true })),
  mode: Type.Optional(
    Type.Union([Type.Literal("sources"), Type.Literal("debug"), Type.Literal("symbol")], {
      default: "sources",
    }),
  ),
  symbol: Type.Optional(Type.String({ description: "Exact symbol name for structural search." })),
  operation: Type.Optional(
    Type.Union([
      Type.Literal("definitions"),
      Type.Literal("references"),
      Type.Literal("callingFunctions"),
      Type.Literal("usingFunctions"),
    ]),
  ),
  scope: Type.Optional(
    Type.Union([Type.Literal("source"), Type.Literal("test"), Type.Literal("all")], {
      default: "all",
    }),
  ),
  maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, default: 100 })),
});

export const impactSchema = Type.Object({
  file: Type.String({ description: "Changed file path to analyze for affected pages/API/tests." }),
  root: Type.Optional(
    Type.String({ description: "Root to query; host paths require access mode 4." }),
  ),
  maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 30 })),
  includeTests: Type.Optional(Type.Boolean({ default: true })),
});

export type StatusInput = Static<typeof statusSchema>;
export type RefreshInput = Static<typeof refreshSchema>;
export type SearchInput = Static<typeof searchSchema>;
export type ImpactInput = Static<typeof impactSchema>;
