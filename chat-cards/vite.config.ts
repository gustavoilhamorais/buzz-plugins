import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  oxc: { jsx: { runtime: "classic" } },
  build: {
    outDir: ".",
    emptyOutDir: false,
    copyPublicDir: false,
    lib: { entry: "src/index.tsx", formats: ["es"], fileName: () => "plugin.js" },
    rolldownOptions: { output: { codeSplitting: false } },
    minify: false,
  },
  plugins: [
    {
      name: "plugin-contract",
      enforce: "pre",
      apply: "build",
      resolveId(id) {
        if (/^react(?:-dom)?(?:\/|$)/.test(id) || id === "@buzz/author")
          throw new Error("Buzz supplies React and the plugin API at runtime; import them as types only");
      },
      generateBundle(_options, bundle) {
        const outputs = Object.values(bundle);
        const module = outputs[0];
        if (outputs.length !== 1 || module?.type !== "chunk" || module.imports.length)
          throw new Error("A Buzz plugin is one self-contained plugin.js module");
        if (!module.exports.includes("apply")) throw new Error("plugin.js must export apply(ctx)");
      },
    },
  ],
});
