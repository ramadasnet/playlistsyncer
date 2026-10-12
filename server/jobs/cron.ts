// Match 5-field cron expressions in UTC, including lists, ranges, steps, and month or weekday names.

const aliases: Record<string, string> = {
    "@hourly": "0 * * * *",
    "@daily": "0 0 * * *",
    "@weekly": "0 0 * * 0",
    "@monthly": "0 0 1 * *"
}

const monthNames: Record<string, number> = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12
}

const weekdayNames: Record<string, number> = {
    sun: 0,
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6
}

export interface CronField {
    values: "any" | Set<number>
    // True when the field contains "*", including steps such as */2.
    starred: boolean
}

export interface ParsedCron {
    minute: CronField
    hour: CronField
    dayOfMonth: CronField
    month: CronField
    dayOfWeek: CronField
}

// Parse one cron expression. `@hourly`, `@daily`, `@weekly`, and `@monthly` are accepted.
export function parseCron(expression: string): ParsedCron {
    const trimmed = expression.trim()
    const expanded = trimmed.startsWith("@") ? aliases[trimmed.toLowerCase()] : trimmed
    if (!expanded) {
        throw new Error(`Unknown schedule alias ${trimmed}`)
    }
    const fields = expanded.split(/\s+/)
    const [minute, hour, dayOfMonth, month, dayOfWeek] = fields
    if (fields.length !== 5 || !minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
        throw new Error("Schedule must be a 5-field cron expression (minute hour day month weekday) or @hourly, @daily, @weekly, or @monthly")
    }
    return {
        minute: parseField("minute", minute, 0, 59),
        hour: parseField("hour", hour, 0, 23),
        dayOfMonth: parseField("day of month", dayOfMonth, 1, 31),
        month: parseField("month", month, 1, 12, monthNames),
        dayOfWeek: parseField("weekday", dayOfWeek, 0, 7, weekdayNames, (value) => (value === 7 ? 0 : value))
    }
}

// Whether the expression matches this instant. Day-of-month and weekday are OR'd only when both omit "*".
export function cronMatches(cron: ParsedCron, date: Date): boolean {
    if (!matches(cron.minute, date.getUTCMinutes()) || !matches(cron.hour, date.getUTCHours()) || !matches(cron.month, date.getUTCMonth() + 1)) {
        return false
    }
    const dayOfMonth = matches(cron.dayOfMonth, date.getUTCDate())
    const dayOfWeek = matches(cron.dayOfWeek, date.getUTCDay())
    // A field that contains "*" is unrestricted, so */1 still means every day rather than a listed set of days.
    if (cron.dayOfMonth.starred || cron.dayOfWeek.starred) return dayOfMonth && dayOfWeek
    return dayOfMonth || dayOfWeek
}

// Milliseconds until the next UTC minute boundary. A timestamp already on the boundary waits a full minute.
export function delayUntilNextMinute(now = new Date()): number {
    return (60 - now.getUTCSeconds()) * 1000 - now.getUTCMilliseconds()
}

function matches(field: CronField, value: number): boolean {
    return field.values === "any" || field.values.has(value)
}

function parseField(label: string, raw: string, min: number, max: number, names?: Record<string, number>, normalize?: (value: number) => number): CronField {
    try {
        const field = substituteNames(raw, names)
        const starred = field.includes("*")
        if (field === "*") return {values: "any", starred}
        const values = new Set<number>()
        for (const part of field.split(",")) {
            if (!part) throw new Error("empty list entry")
            const [range, stepRaw, extra] = part.split("/")
            if (extra !== undefined || !range) throw new Error(`invalid value ${part}`)
            const step = stepRaw === undefined ? 1 : Number(stepRaw)
            if (!Number.isInteger(step) || step < 1) throw new Error(`invalid step ${stepRaw}`)
            let start: number
            let end: number
            if (range === "*") {
                start = min
                end = max
            } else if (range.includes("-")) {
                const [from, to, extraBound] = range.split("-")
                if (!from || !to || extraBound !== undefined) throw new Error(`invalid range ${range}`)
                start = bound(from, min, max)
                end = bound(to, min, max)
                if (start > end) throw new Error(`invalid range ${range}`)
            } else {
                if (stepRaw !== undefined) throw new Error(`invalid step in ${part}`)
                start = bound(range, min, max)
                end = start
            }
            for (let value = start; value <= end; value += step) {
                values.add(normalize ? normalize(value) : value)
            }
        }
        if (!values.size) throw new Error("matched no values")
        return {values, starred}
    } catch (error) {
        const message = error instanceof Error ? error.message : "invalid value"
        throw new Error(`${label}: ${message}`)
    }
}

function substituteNames(raw: string, names?: Record<string, number>): string {
    if (!names) return raw
    return raw.replace(/[A-Za-z]+/g, (token) => {
        const value = names[token.toLowerCase()]
        if (value === undefined) throw new Error(`unknown name ${token}`)
        return String(value)
    })
}

function bound(raw: string, min: number, max: number): number {
    if (!/^\d+$/.test(raw)) throw new Error(`invalid value ${raw}`)
    const value = Number(raw)
    if (value < min || value > max) throw new Error(`${value} is outside ${min}-${max}`)
    return value
}
