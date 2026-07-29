import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    globals: true,
    // A positive include list, deliberately, rather than excluding what we
    // don't want. The addon's tests live only in these two trees.
    //
    // Two things this protects against, both of which actually happened:
    //   • `companion/` is a SEPARATE vitest project with its own
    //     node-environment config. When the root project also collected it,
    //     every companion file ran twice under two different configs — which
    //     is how a `vi.mock('fs')` that only works for namespace imports came
    //     to dictate the shape of production code.
    //   • A git worktree created under `.claude/worktrees/<name>/` is a full
    //     second copy of this repo INSIDE it. An `exclude: ['companion/**']`
    //     does not match `.claude/worktrees/x/companion/**`, so the root
    //     project happily ran the entire worktree — companion tests included,
    //     under jsdom, reintroducing the bug above by a different path.
    //
    // An exclude list has to anticipate every such path; an include list only
    // has to name the two we own.
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'shared/**/*.{test,spec}.{ts,tsx}'],
    exclude: [...configDefaults.exclude, 'companion/**'],
  },
});
