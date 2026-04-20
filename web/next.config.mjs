/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  experimental: {
    // Needed because Auth.js uses node APIs in middleware; setting this
    // keeps the default Node.js runtime and avoids edge-runtime errors.
  },
};

export default nextConfig;
