import type { NextConfig } from "next";
import zodCompiler from "zod-compiler/webpack";

const nextConfig: NextConfig = {
  webpack: (config) => {
    config.plugins?.push(zodCompiler({ verbose: true }));
    return config;
  },
};

export default nextConfig;
