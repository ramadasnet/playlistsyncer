// Store the authenticated user and expose logout behavior to the app shell.
import {defineStore} from "pinia"
import {api} from "~/utils/api"
import type {SessionUser} from "~/types/api"

// Central client-side session state.
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
            await api("/api/auth/logout", {method: "POST"})
            this.setUser(null)
            await navigateTo("/")
        }
    }
})
