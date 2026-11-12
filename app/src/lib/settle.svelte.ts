import { untrack } from 'svelte';

/** 값이 바뀌고 ms 동안 더 바뀌지 않으면 따라가는 값. 슬라이더를 끄는 동안은 CSS 로만 보이고, 멈춘 뒤에 해상도를 다시 그리는 데 쓴다 */
export function settled(get: () => number, ms = 220): { readonly value: number } {
  let v = $state(untrack(get));
  $effect(() => {
    const n = get();
    if (n === untrack(() => v)) return;
    const t = setTimeout(() => (v = n), ms);
    return () => clearTimeout(t);
  });
  return {
    get value() {
      return v;
    },
  };
}
