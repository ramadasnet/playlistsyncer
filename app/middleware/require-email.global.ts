export default defineNuxtRouteMiddleware((to) => {
    const auth = useAuthStore()
    if (!auth.loaded || !auth.user) {
        return
    }
    if (auth.user.email || auth.user.tempEmail) {
        return
    }
    if (to.path === "/account" || to.path === "/confirm-email") {
        return
    }
    return navigateTo("/account")
})
