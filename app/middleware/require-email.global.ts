// Redirect authenticated users without an email to the account confirmation flow.
export default defineNuxtRouteMiddleware((to) => {
    const auth = useAuthStore()
    if (!auth.loaded || !auth.user) {
        return
    }
    if (auth.user.email || auth.user.tempEmail) {
        return
    }
    if (to.path === "/account" || to.path === "/confirm-email" || to.path === "/support" || to.path === "/impressum") {
        return
    }
    return navigateTo("/account")
})
