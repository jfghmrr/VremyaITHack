// Окружение Vitest для проверки реактивности: модули .svelte.ts собираются клиентским
// компилятором Svelte (а не серверным, где $effect не выполняется). DOM не нужен.
import type { Environment } from "vitest/runtime";

export default <Environment>{
  name: "svelte-client",
  viteEnvironment: "client",
  setup() {
    return { teardown() {} };
  },
};
