import { createCodePlugin } from "@streamdown/code";

/**
 * The ONE Streamdown plugin set, shared by every markdown surface. Each
 * `createCodePlugin` call stands up its own Shiki highlighter, so this must
 * stay a module-scope singleton rather than a per-component constant.
 *
 * `min-*` are the lowest-chroma bundled Shiki themes, which is what a
 * greyscale console wants: code is the one place colour may mean something
 * other than state, so it stays quiet.
 *
 * Order is [light, dark]. Streamdown emits BOTH and swaps with Tailwind's
 * `dark:` variant (`--shiki-dark`), so this follows the theme toggle with no
 * further wiring.
 */
export const markdownPlugins = {
  code: createCodePlugin({ themes: ["min-light", "min-dark"] }),
};
