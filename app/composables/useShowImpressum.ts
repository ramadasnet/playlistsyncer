export async function useShowImpressum() {
    const {data} = await useFetch<{showImpressum: boolean}>("/api/geo", {
        key: "visitor-geo",
        default: () => ({showImpressum: false})
    })
    const showImpressum = computed(() => Boolean(data.value?.showImpressum))
    return {showImpressum}
}
