// Serve a sitemap of the public pages so crawlers can discover them.
export default defineEventHandler((event) => {
    const siteUrl = String(useRuntimeConfig(event).public.siteUrl).replace(/\/$/, "")
    const paths = ["/", "/features", "/support", "/terms", "/impressum"]
    const urls = paths.map((path) => `  <url><loc>${siteUrl}${path}</loc></url>`).join("\n")
    setResponseHeader(event, "content-type", "application/xml; charset=utf-8")
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
})
