import js from "@eslint/js";
import perfectionist from "eslint-plugin-perfectionist";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist", "generated", "node_modules"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { perfectionist },
    rules: {
      "perfectionist/sort-imports": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
