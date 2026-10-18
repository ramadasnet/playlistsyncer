/** Redirect unauthenticated staff before protected page setup or data fetching. */
export default defineNuxtRouteMiddleware(async (to) => {
    const {data, error} = await useFetch("/api/session", {key: "admin-session"})
    if (error.value) throw createError({statusCode: 503, statusMessage: "Admin authentication is unavailable"})
    if (!data.value?.admin && to.path !== "/login") return navigateTo("/login")
    if (data.value?.admin && to.path === "/login") return navigateTo("/")
})
