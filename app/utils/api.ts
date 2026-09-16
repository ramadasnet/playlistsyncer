// Attach the double-submit CSRF token to state-changing browser requests.
import {$fetch} from "ofetch"

function csrfToken(): string {
    const match = document.cookie.match(/(?:^|; )ps_csrf=([^;]*)/)
    return match ? decodeURIComponent(match[1]!) : ""
}

// Same instance as $fetch but sends the x-csrf-token header on POST, PUT, PATCH, and DELETE calls.
export const api = $fetch.create({
    onRequest(context) {
        const method = (context.options.method || "GET").toUpperCase()
        if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
            const headers = new Headers(context.options.headers)
            headers.set("x-csrf-token", csrfToken())
            context.options.headers = headers
        }
    }
})
