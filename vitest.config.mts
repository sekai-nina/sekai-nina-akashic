import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // worktree 運用なので、main から実行したとき .claude/worktrees/ 配下の
    // 他ブランチのテストまで拾ってしまう
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
