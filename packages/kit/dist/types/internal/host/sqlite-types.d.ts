import type { TwsHostStore } from "./store.js";
export type TwsSqliteValue = null | string | number | Uint8Array;
export type TwsSqliteBindings = Readonly<Record<string, TwsSqliteValue>>;
export type TwsSqliteRow = Readonly<Record<string, TwsSqliteValue>>;
export interface TwsSqliteRunResult {
    readonly changes: number;
}
export interface TwsSqliteTransaction {
    readonly run: (sql: string, bindings?: TwsSqliteBindings) => Promise<TwsSqliteRunResult>;
    readonly get: (sql: string, bindings?: TwsSqliteBindings) => Promise<TwsSqliteRow | null>;
    readonly all: (sql: string, bindings?: TwsSqliteBindings) => Promise<readonly TwsSqliteRow[]>;
}
export interface TwsSqliteDriver {
    readonly dialect: "sqlite";
    readonly transaction: <T>(work: (transaction: TwsSqliteTransaction) => Promise<T>) => Promise<T>;
    readonly close?: () => Promise<void>;
}
export interface TwsSqliteHostStoreOptions {
    readonly driver: TwsSqliteDriver;
    readonly namespace: string;
    readonly now?: () => number;
}
export type TwsSqliteHostStore = TwsHostStore;
