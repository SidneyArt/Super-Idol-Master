import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The local Vinext worker does not have Cloudflare ASSETS/IMAGES bindings.
  // Serve project images directly so local previews never call the hosted
  // image-optimization endpoint.
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
