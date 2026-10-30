import {createError, defineEventHandler, getRouterParam, readBody} from "h3"
import {ZodError} from "zod"
import {deleteTask, deleteUser, discoverSubscriptions, getTask, getUser, listTasks, listUsers, statistics, updateSubscription, updateTask, updateUser} from "../utils/management"

export default defineEventHandler(async (event) => {
    const path = (getRouterParam(event, "path") || "").split("/")
    const [resource, id, action] = path
    if (path.length > 3) throw createError({statusCode: 404})
    try {
        if (event.method === "GET" && resource === "stats" && !id) return await statistics()
        if (event.method === "POST" && resource === "subscriptions" && id === "discover" && !action) return await discoverSubscriptions(event)
        if (event.method === "GET" && resource === "users" && !action) return id ? await getUser(id) : await listUsers(event)
        if (event.method === "GET" && resource === "tasks" && !action) return id ? await getTask(id) : await listTasks(event)
        if (event.method === "PATCH" && resource === "users" && id && !action) return await updateUser(event, id, await readBody(event))
        if (event.method === "PATCH" && resource === "tasks" && id && !action) return await updateTask(event, id, await readBody(event))
        if (event.method === "DELETE" && resource === "users" && id && !action) return await deleteUser(event, id)
        if (event.method === "DELETE" && resource === "tasks" && id && !action) return await deleteTask(event, id)
        if (event.method === "POST" && resource === "tasks" && id && action === "cancel") return await updateTask(event, id, null, true)
        if (event.method === "POST" && resource === "users" && id && action === "subscription") return await updateSubscription(event, id, await readBody(event))
        throw createError({statusCode: 404, statusMessage: "Admin endpoint not found"})
    } catch (error) {
        if (error instanceof ZodError) throw createError({statusCode: 400, statusMessage: "Invalid request", data: error.flatten()})
        if (typeof error === "object" && error && "code" in error && error.code === 11000) throw createError({statusCode: 409, statusMessage: "That value is already in use"})
        throw error
    }
})
