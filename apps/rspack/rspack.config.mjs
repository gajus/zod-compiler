import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import zodCompiler from "zod-compiler/rspack";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('@rspack/core').Configuration} */
export default {
  entry: "./src/main.ts",
  target: "node",
  output: {
    path: resolve(__dirname, "dist"),
    filename: "main.js",
    module: true,
    chunkFormat: "module",
    library: { type: "module" },
  },
  experiments: {
    outputModule: true,
  },
  resolve: {
    extensions: [".ts", ".js"],
    extensionAlias: {
      ".js": [".ts", ".js"],
    },
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        loader: "builtin:swc-loader",
        options: {
          jsc: {
            parser: { syntax: "typescript" },
          },
        },
        exclude: /node_modules/,
      },
    ],
  },
  plugins: [zodCompiler({ verbose: true })],
  externals: { zod: "module zod" },
  externalsType: "module",
};
