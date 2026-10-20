import type {getTask, getUser, listTasks, listUsers, statistics} from "../server/utils/management"

type JsonValue<Value> = Value extends Date ? string : Value extends readonly (infer Item)[] ? JsonValue<Item>[] : Value extends object ? {[Key in keyof Value]: JsonValue<Value[Key]>} : Value

export type UserDetail = JsonValue<Awaited<ReturnType<typeof getUser>>>
export type UserList = JsonValue<Awaited<ReturnType<typeof listUsers>>>
export type TaskDetail = JsonValue<Awaited<ReturnType<typeof getTask>>>
export type TaskList = JsonValue<Awaited<ReturnType<typeof listTasks>>>
export type Statistics = JsonValue<Awaited<ReturnType<typeof statistics>>>
