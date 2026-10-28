import type {MaybeRefOrGetter} from "vue"

// Declares a page's SEO meta and mirrors the title/description into Open Graph and Twitter fields.
export function usePageSeo(input: {title?: MaybeRefOrGetter<string | undefined>; description?: MaybeRefOrGetter<string | undefined>; robots?: MaybeRefOrGetter<string | undefined>}) {
    const appName = String(useRuntimeConfig().public.appName)
    const fullTitle = () => {
        const title = toValue(input.title)
        return title ? `${appName} - ${title}` : appName
    }
    useSeoMeta({
        title: input.title,
        description: input.description,
        ogTitle: fullTitle,
        ogDescription: input.description,
        twitterTitle: fullTitle,
        twitterDescription: input.description,
        robots: input.robots
    })
}
