export default defineNuxtRouteMiddleware(() => {
    const auth = useAuthStore()
    if (auth.loaded && !auth.user) {
        return navigateTo("/login")
    }
})
