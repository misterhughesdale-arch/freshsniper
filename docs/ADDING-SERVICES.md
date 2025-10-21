# Adding New Services/Packages

## Architecture Principles

**Centralized Configuration**: All services share ONE config system

- **Source**: `config/default.toml` (+ environment overrides)
- **Loader**: `packages/config/src/index.ts`
- **Schema**: `packages/config/src/schema.ts` (Zod validation)

## Adding a New Service

### 1. Create Service Directory

```bash
mkdir -p apps/my-service/src
```

### 2. Service Structure

```typescript
// apps/my-service/src/index.ts
import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";
dotenvConfig({ path: resolve(process.cwd(), "../../.env") });

import { loadConfig } from "../../../packages/config/src/index";

// Load centralized config
const config = loadConfig({ 
  configDirectory: resolve(process.cwd(), "../../config") 
});

// Access config sections
console.log(config.rpc.primary_url);
console.log(config.strategy.buy_amount_sol);
```

### 3. Package.json

```json
{
  "name": "my-service",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "tsx src/index.ts"
  },
  "dependencies": {
    "dotenv": "^16.4.7"
  }
}
```

### 4. TypeScript Config

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": undefined
  },
  "include": ["src", "../../packages/**/*.ts"]
}
```

### 5. Add to Root package.json

```json
{
  "scripts": {
    "my-service": "pnpm --filter my-service dev"
  },
  "workspaces": [
    "apps/my-service"
  ]
}
```

## Adding Config Fields

### 1. Update Schema

```typescript
// packages/config/src/schema.ts
export const FreshSniperConfigSchema = z.object({
  // ... existing fields
  my_new_section: z.object({
    enabled: z.boolean().default(true),
    my_setting: z.string(),
  }),
});
```

### 2. Update TOML

```toml
# config/default.toml
[my_new_section]
enabled = true
my_setting = "${MY_ENV_VAR}"
```

### 3. Use in Service

```typescript
const config = loadConfig({ ... });
if (config.my_new_section.enabled) {
  console.log(config.my_new_section.my_setting);
}
```

## Important Paths

When running via pnpm, `process.cwd()` is set to the app directory:

- `pnpm --filter my-service dev` → cwd = `apps/my-service/`

Therefore:

- `.env`: `../../.env`
- `config/`: `../../config`
- `keypairs/`: `../../keypairs`
- `packages/`: `../../../packages`

## NO-NOs

❌ **Don't** create app-level config files  
❌ **Don't** hardcode values  
❌ **Don't** use environment variables directly (use `${VAR}` in TOML)  
❌ **Don't** duplicate config logic  

## Pattern Summary

```
config/default.toml (single source of truth)
    ↓
packages/config/src/index.ts (single loader)
    ↓
packages/config/src/schema.ts (single validator)
    ↓
All apps use: loadConfig({ configDirectory: "../../config" })
```

This ensures:

- ✅ One place to change settings
- ✅ Type-safe config across all services
- ✅ Environment variable substitution
- ✅ Validation before startup
- ✅ Easy to test (inject custom config)
