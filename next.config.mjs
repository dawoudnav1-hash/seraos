/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['@electric-sql/pglite', 'pg', 'exceljs', 'pdf-lib'],
};
export default nextConfig;
