import { onScopeDispose, readonly, ref, type Ref } from 'vue'

/**
 * 回應式的 media query。視窗尺寸或裝置方向改變時會跟著更新。
 */
export function useMediaQuery(query: string): Readonly<Ref<boolean>> {
  const matches = ref(false)

  // SSR 或測試環境可能沒有 matchMedia
  if (typeof window === 'undefined' || !window.matchMedia) {
    return readonly(matches)
  }

  const media = window.matchMedia(query)
  matches.value = media.matches

  const update = (event: MediaQueryListEvent) => {
    matches.value = event.matches
  }

  media.addEventListener('change', update)
  onScopeDispose(() => media.removeEventListener('change', update))

  return readonly(matches)
}
