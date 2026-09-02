import {defineStore} from "pinia"
import type {SessionUser} from "~/types/api"

export const useAuthStore = defineStore("auth", {
    state: () => ({
        user: null as SessionUser | null,
        loaded: false
    }),
    actions: {
        setUser(user: SessionUser | null) {
            this.user = user
            this.loaded = true
        },
        async logout() {
            await $fetch("/api/auth/logout", {method: "POST"})
            this.setUser(null)
            await navigateTo("/")
        }
    }
})
