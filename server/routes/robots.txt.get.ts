// Serve robots.txt derived from the public site URL so self-hosted installs stay correct.
export default defineEventHandler((event) => {
    const siteUrl = String(useRuntimeConfig(event).public.siteUrl).replace(/\/$/, "")
    setResponseHeader(event, "content-type", "text/plain; charset=utf-8")
    return ["User-agent: *", "Disallow: /api/", "Disallow: /account", "Disallow: /sync", "Disallow: /confirm-email", "Disallow: /apple-music-pending.html", "", `Sitemap: ${siteUrl}/sitemap.xml`].join("\n")
})
