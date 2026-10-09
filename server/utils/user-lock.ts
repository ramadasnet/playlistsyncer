// Serialize account and task changes for one user inside this web server process.
import type {ObjectId} from "mongodb"

const tails = new Map<string, Promise<void>>()

// Run an action after earlier actions for the same user finish, including when they fail.
export function withUserLock<T>(userId: ObjectId, action: () => Promise<T>): Promise<T> {
    const key = userId.toHexString()
    const previous = tails.get(key) ?? Promise.resolve()
    const run = previous.then(action)
    const tail = run.then(
        () => undefined,
        () => undefined
    )
    tails.set(key, tail)
    void tail.finally(() => {
        if (tails.get(key) === tail) {
            tails.delete(key)
        }
    })
    return run
}
