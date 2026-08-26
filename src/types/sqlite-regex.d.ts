// Minimal ambient declaration for the pinned `sqlite-regex` package
// (v0.2.4-alpha.1, ESM, no upstream types). `src/**/*.ts` is included
// by tsconfig.json so this is picked up by the typechecker.
declare module "sqlite-regex" {
  export function getLoadablePath(): string;
}
